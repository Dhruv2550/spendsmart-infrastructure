"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, PutCommand, DeleteCommand, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const corsHeaders = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

const createResponse = (statusCode, body) => ({
    statusCode,
    headers: corsHeaders,
    body: JSON.stringify(body)
});

exports.handler = async (event) => {
    console.log('Event:', JSON.stringify(event, null, 2));
    
    if (event.httpMethod === 'OPTIONS') {
        return createResponse(200, {});
    }
    
    try {
        const { httpMethod, pathParameters, body } = event;
        const templateName = pathParameters?.templateName;
        
        switch (httpMethod) {
            case 'GET':
                return await getBudgetTemplates();
            
            case 'POST':
                if (pathParameters?.action === 'copy') {
                    return await copyBudgetTemplate(templateName, JSON.parse(body || '{}'));
                }
                return await createBudgetTemplate(JSON.parse(body || '{}'));
            
            case 'DELETE':
                return await deleteBudgetTemplate(templateName);
            
            default:
                return createResponse(405, { error: 'Method not allowed' });
        }
        
    } catch (error) {
        console.error('Error:', error);
        return createResponse(500, { error: 'Internal server error', details: error.message });
    }
};

async function getBudgetTemplates() {
    const params = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: {
            ':pk': 'TEMPLATE#'
        }
    };
    
    const result = await dynamodb.send(new ScanCommand(params));
    
    // Group by template name and calculate summary stats
    const templatesMap = new Map();
    
    result.Items.forEach((item) => {
        const templateName = item.template_name;
        if (!templatesMap.has(templateName)) {
            templatesMap.set(templateName, {
                template_name: templateName,
                category_count: 0,
                total_budget: 0,
                last_updated: item.created_at
            });
        }
        
        const template = templatesMap.get(templateName);
        template.category_count += 1;
        template.total_budget += item.budget_amount || 0;
        
        // Update last_updated if this item is newer
        if (item.created_at > template.last_updated) {
            template.last_updated = item.created_at;
        }
    });
    
    return createResponse(200, Array.from(templatesMap.values()));
}

async function createBudgetTemplate(data) {
    const { template_name, categories } = data;
    
    if (!template_name || !categories || !Array.isArray(categories)) {
        return createResponse(400, { error: 'Missing template_name or categories array' });
    }
    
    const timestamp = new Date().toISOString();
    const writeRequests = [];
    
    for (const category of categories) {
        const { category: categoryName, budget_amount, rollover_enabled = false } = category;
        
        if (!categoryName || budget_amount === undefined) {
            return createResponse(400, { error: 'Each category must have category name and budget_amount' });
        }
        
        const item = {
            PK: `TEMPLATE#${template_name}`,
            SK: `CATEGORY#${categoryName}`,
            GSI1PK: `TEMPLATE_ALL`,
            GSI1SK: `${template_name}#${categoryName}`,
            template_name,
            category: categoryName,
            budget_amount: parseFloat(budget_amount),
            rollover_enabled,
            is_active: true,
            created_at: timestamp
        };
        
        writeRequests.push({
            PutRequest: { Item: item }
        });
    }
    
    // Batch write all categories
    if (writeRequests.length > 0) {
        const chunks = [];
        for (let i = 0; i < writeRequests.length; i += 25) {
            chunks.push(writeRequests.slice(i, i + 25));
        }
        
        for (const chunk of chunks) {
            await dynamodb.send(new BatchWriteCommand({
                RequestItems: {
                    [`${TABLE_NAME}`]: chunk
                }
            }));
        }
    }
    
    return createResponse(201, {
        template_name,
        categories_created: categories.length,
        message: 'Budget template created successfully'
    });
}

async function copyBudgetTemplate(sourceTemplateName, data) {
    const { new_template_name } = data;
    
    if (!sourceTemplateName || !new_template_name) {
        return createResponse(400, { error: 'Missing source template name or new template name' });
    }
    
    // Get source template categories
    const queryParams = {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
            ':pk': `TEMPLATE#${sourceTemplateName}`
        }
    };
    
    const sourceResult = await dynamodb.send(new QueryCommand(queryParams));
    
    if (!sourceResult.Items || sourceResult.Items.length === 0) {
        return createResponse(404, { error: 'Source template not found' });
    }
    
    const timestamp = new Date().toISOString();
    const writeRequests = [];
    
    for (const sourceItem of sourceResult.Items) {
        const newItem = {
            PK: `TEMPLATE#${new_template_name}`,
            SK: sourceItem.SK,
            GSI1PK: `TEMPLATE_ALL`,
            GSI1SK: `${new_template_name}#${sourceItem.category}`,
            template_name: new_template_name,
            category: sourceItem.category,
            budget_amount: sourceItem.budget_amount,
            rollover_enabled: sourceItem.rollover_enabled,
            is_active: true,
            created_at: timestamp
        };
        
        writeRequests.push({
            PutRequest: { Item: newItem }
        });
    }
    
    // Batch write new template
    const chunks = [];
    for (let i = 0; i < writeRequests.length; i += 25) {
        chunks.push(writeRequests.slice(i, i + 25));
    }
    
    for (const chunk of chunks) {
        await dynamodb.send(new BatchWriteCommand({
            RequestItems: {
                [`${TABLE_NAME}`]: chunk
            }
        }));
    }
    
    return createResponse(201, {
        source_template: sourceTemplateName,
        new_template: new_template_name,
        categories_copied: sourceResult.Items.length,
        message: 'Budget template copied successfully'
    });
}

async function deleteBudgetTemplate(templateName) {
    // ADD URL DECODING HERE
    const decodedTemplateName = decodeURIComponent(templateName || '');
    console.log('Deleting template - Original:', templateName, 'Decoded:', decodedTemplateName);
    
    if (!decodedTemplateName) {
        return createResponse(400, { error: 'Missing template name' });
    }
    
    // Get all categories for this template - USE DECODED NAME
    const queryParams = {
        TableName: TABLE_NAME,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: {
            ':pk': `TEMPLATE#${decodedTemplateName}`
        }
    };
    
    const result = await dynamodb.send(new QueryCommand(queryParams));
    
    if (!result.Items || result.Items.length === 0) {
        return createResponse(404, { error: 'Template not found' });
    }
    
    const deleteRequests = [];
    
    for (const item of result.Items) {
        deleteRequests.push({
            DeleteRequest: {
                Key: {
                    PK: item.PK,
                    SK: item.SK
                }
            }
        });
    }
    
    // Batch delete all categories
    const chunks = [];
    for (let i = 0; i < deleteRequests.length; i += 25) {
        chunks.push(deleteRequests.slice(i, i + 25));
    }
    
    for (const chunk of chunks) {
        await dynamodb.send(new BatchWriteCommand({
            RequestItems: {
                [`${TABLE_NAME}`]: chunk
            }
        }));
    }
    
    return createResponse(200, {
        template_name: decodedTemplateName,
        categories_deleted: result.Items.length,
        message: 'Budget template deleted successfully'
    });
}