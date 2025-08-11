const { DynamoDBClient, QueryCommand, PutItemCommand, UpdateItemCommand, DeleteItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoDb = new DynamoDBClient({ region: 'us-east-1' });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
    console.log('Event received:', JSON.stringify(event, null, 2));
    
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    };

    try {
        const { httpMethod, pathParameters, body } = event;
        
        // Handle preflight requests
        if (httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ message: 'CORS preflight successful' })
            };
        }

        // Route to appropriate handler
        switch (httpMethod) {
            case 'GET':
            if (pathParameters?.id) {
                return await getAlert(pathParameters.id, headers);
            } else {
                return await getAllAlerts(headers);
            }
            case 'POST':
                return await createAlert(JSON.parse(body || '{}'), headers);
            case 'PUT':
                if (!pathParameters?.id) {
                    throw new Error('Alert ID is required for updates');
                }
                return await updateAlert(pathParameters.id, JSON.parse(body || '{}'), headers);
            case 'DELETE':
                if (!pathParameters?.id) {
                    throw new Error('Alert ID is required for deletion');
                }
            case 'PATCH':
                // Handle PATCH endpoints for alert actions
                if (pathParameters?.id && event.path?.includes('/read')) {
                    return await markAlertAsRead(pathParameters.id, headers);
                } else if (pathParameters?.id && event.path?.includes('/dismiss')) {
                    return await dismissAlert(pathParameters.id, headers);
                } else if (event.path?.includes('/dismiss-all/')) {
                    const monthFromPath = event.path.split('/dismiss-all/')[1];
                    return await dismissAllAlerts(monthFromPath, headers);
                } else {
                    throw new Error('Invalid PATCH endpoint');
                }
                            return await deleteAlert(pathParameters.id, headers);
            default:
                throw new Error(`Unsupported method: ${httpMethod}`);
        }
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: error.statusCode || 500,
            headers,
            body: JSON.stringify({
                error: error.message || 'Internal server error'
            })
        };
    }
};

// GET /api/alerts - Get all spending alerts
async function getAllAlerts(headers) {
    console.log('Getting all spending alerts');
    
    const params = {
        TableName: TABLE_NAME,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :gsi1pk',
        ExpressionAttributeValues: marshall({
            ':gsi1pk': 'ALERTS'
        })
    };

    const result = await dynamoDb.send(new QueryCommand(params));
    const alerts = result.Items?.map(item => unmarshall(item)) || [];
    
    console.log(`Found ${alerts.length} alerts`);
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            data: alerts,
            count: alerts.length
        })
    };
}

// GET /api/alerts/{id} - Get specific spending alert
async function getAlert(alertId, headers) {
    console.log('Getting specific alert:', alertId);
    
    const params = {
        TableName: TABLE_NAME,
        Key: marshall({
            PK: `ALERT#${alertId}`,
            SK: `ALERT#${alertId}`
        })
    };

    try {
        const { GetItemCommand } = require('@aws-sdk/client-dynamodb');
        const result = await dynamoDb.send(new GetItemCommand(params));
        
        if (!result.Item) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({
                    success: false,
                    error: 'Alert not found'
                })
            };
        }
        
        const alert = unmarshall(result.Item);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: alert
            })
        };
    } catch (error) {
        console.error('Error getting alert:', error);
        throw error;
    }
}

// POST /api/alerts - Create new spending alert
async function createAlert(alertData, headers) {
    console.log('Creating new alert:', alertData);
    
    // Validate required fields
    const requiredFields = ['name', 'type', 'condition', 'threshold'];
    for (const field of requiredFields) {
        if (!alertData[field]) {
            throw Object.assign(new Error(`Missing required field: ${field}`), { statusCode: 400 });
        }
    }
    
    // Validate alert type
    const validTypes = ['BUDGET_EXCEEDED', 'SPENDING_PATTERN', 'CATEGORY_LIMIT', 'MONTHLY_THRESHOLD'];
    if (!validTypes.includes(alertData.type)) {
        throw Object.assign(new Error(`Invalid alert type. Must be one of: ${validTypes.join(', ')}`), { statusCode: 400 });
    }
    
    // Validate condition
    const validConditions = ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'PERCENTAGE_OF_BUDGET'];
    if (!validConditions.includes(alertData.condition)) {
        throw Object.assign(new Error(`Invalid condition. Must be one of: ${validConditions.join(', ')}`), { statusCode: 400 });
    }
    
    // Generate unique alert ID
    const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();
    
    const alert = {
        PK: `ALERT#${alertId}`,
        SK: `ALERT#${alertId}`,
        GSI1PK: 'ALERTS',
        GSI1SK: timestamp,
        id: alertId,
        name: alertData.name,
        type: alertData.type,
        condition: alertData.condition,
        threshold: parseFloat(alertData.threshold),
        category: alertData.category || null,
        budgetTemplate: alertData.budgetTemplate || null,
        isActive: alertData.isActive !== undefined ? alertData.isActive : true,
        notificationMethods: alertData.notificationMethods || ['APP'],
        description: alertData.description || '',
        createdAt: timestamp,
        updatedAt: timestamp
    };
    
    const params = {
        TableName: TABLE_NAME,
        Item: marshall(alert)
    };
    
    await dynamoDb.send(new PutItemCommand(params));
    
    console.log('Alert created successfully:', alertId);
    
    return {
        statusCode: 201,
        headers,
        body: JSON.stringify({
            success: true,
            message: 'Alert created successfully',
            data: alert
        })
    };
}

// PUT /api/alerts/{id} - Update spending alert
async function updateAlert(alertId, updateData, headers) {
    console.log('Updating alert:', alertId, updateData);
    
    // Validate alert type if provided
    if (updateData.type) {
        const validTypes = ['BUDGET_EXCEEDED', 'SPENDING_PATTERN', 'CATEGORY_LIMIT', 'MONTHLY_THRESHOLD'];
        if (!validTypes.includes(updateData.type)) {
            throw Object.assign(new Error(`Invalid alert type. Must be one of: ${validTypes.join(', ')}`), { statusCode: 400 });
        }
    }
    
    // Validate condition if provided
    if (updateData.condition) {
        const validConditions = ['GREATER_THAN', 'GREATER_THAN_OR_EQUAL', 'PERCENTAGE_OF_BUDGET'];
        if (!validConditions.includes(updateData.condition)) {
            throw Object.assign(new Error(`Invalid condition. Must be one of: ${validConditions.join(', ')}`), { statusCode: 400 });
        }
    }
    
    // Build update expression
    const updateExpressions = [];
    const expressionAttributeNames = {};
    const expressionAttributeValues = {};
    
    const updatableFields = ['name', 'type', 'condition', 'threshold', 'category', 'budgetTemplate', 'isActive', 'notificationMethods', 'description'];
    
    updatableFields.forEach(field => {
        if (updateData[field] !== undefined) {
            updateExpressions.push(`#${field} = :${field}`);
            expressionAttributeNames[`#${field}`] = field;
            
            if (field === 'threshold') {
                expressionAttributeValues[`:${field}`] = parseFloat(updateData[field]);
            } else {
                expressionAttributeValues[`:${field}`] = updateData[field];
            }
        }
    });
    
    if (updateExpressions.length === 0) {
        throw Object.assign(new Error('No valid fields provided for update'), { statusCode: 400 });
    }
    
    // Always update the updatedAt timestamp
    updateExpressions.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    expressionAttributeValues[':updatedAt'] = new Date().toISOString();
    
    const params = {
        TableName: TABLE_NAME,
        Key: marshall({
            PK: `ALERT#${alertId}`,
            SK: `ALERT#${alertId}`
        }),
        UpdateExpression: `SET ${updateExpressions.join(', ')}`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
        ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamoDb.send(new UpdateItemCommand(params));
    
    if (!result.Attributes) {
        throw Object.assign(new Error('Alert not found'), { statusCode: 404 });
    }
    
    const updatedAlert = unmarshall(result.Attributes);
    
    console.log('Alert updated successfully:', alertId);
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            message: 'Alert updated successfully',
            data: updatedAlert
        })
    };
}

// DELETE /api/alerts/{id} - Delete spending alert
async function deleteAlert(alertId, headers) {
    console.log('Deleting alert:', alertId);
    
    const params = {
        TableName: TABLE_NAME,
        Key: marshall({
            PK: `ALERT#${alertId}`,
            SK: `ALERT#${alertId}`
        }),
        ReturnValues: 'ALL_OLD'
    };
    
    const result = await dynamoDb.send(new DeleteItemCommand(params));
    
    if (!result.Attributes) {
        throw Object.assign(new Error('Alert not found'), { statusCode: 404 });
    }
    
    const deletedAlert = unmarshall(result.Attributes);
    
    console.log('Alert deleted successfully:', alertId);
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            message: 'Alert deleted successfully',
            data: deletedAlert
        })
    };

    // PATCH /api/alerts/{id}/read - Mark alert as read
async function markAlertAsRead(alertId, headers) {
    console.log('Marking alert as read:', alertId);
    
    const params = {
        TableName: TABLE_NAME,
        Key: marshall({
            PK: `ALERT#${alertId}`,
            SK: `ALERT#${alertId}`
        }),
        UpdateExpression: 'SET is_read = :isRead, updatedAt = :updatedAt',
        ExpressionAttributeValues: marshall({
            ':isRead': true,
            ':updatedAt': new Date().toISOString()
        }),
        ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamoDb.send(new UpdateItemCommand(params));
    
    if (!result.Attributes) {
        throw Object.assign(new Error('Alert not found'), { statusCode: 404 });
    }
    
    const updatedAlert = unmarshall(result.Attributes);
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            message: 'Alert marked as read',
            data: updatedAlert
        })
    };
}

// PATCH /api/alerts/{id}/dismiss - Dismiss specific alert
async function dismissAlert(alertId, headers) {
    console.log('Dismissing alert:', alertId);
    
    const params = {
        TableName: TABLE_NAME,
        Key: marshall({
            PK: `ALERT#${alertId}`,
            SK: `ALERT#${alertId}`
        }),
        UpdateExpression: 'SET is_dismissed = :isDismissed, updatedAt = :updatedAt',
        ExpressionAttributeValues: marshall({
            ':isDismissed': true,
            ':updatedAt': new Date().toISOString()
        }),
        ReturnValues: 'ALL_NEW'
    };
    
    const result = await dynamoDb.send(new UpdateItemCommand(params));
    
    if (!result.Attributes) {
        throw Object.assign(new Error('Alert not found'), { statusCode: 404 });
    }
    
    const updatedAlert = unmarshall(result.Attributes);
    
    return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
            success: true,
            message: 'Alert dismissed',
            data: updatedAlert
        })
    };
}

    // PATCH /api/alerts/dismiss-all/{month} - Dismiss all alerts for a month
    async function dismissAllAlerts(month, headers) {
        console.log('Dismissing all alerts for month:', month);
        
        // First, get all alerts for the month
        const queryParams = {
            TableName: TABLE_NAME,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :gsi1pk',
            ExpressionAttributeValues: marshall({
                ':gsi1pk': 'ALERTS'
            })
        };
        
        const result = await dynamoDb.send(new QueryCommand(queryParams));
        const alerts = result.Items?.map(item => unmarshall(item)) || [];
        
        // Filter by month and update each alert
        const alertsToUpdate = alerts.filter(alert => alert.month === month || !alert.month);
        
        const updatePromises = alertsToUpdate.map(alert => {
            const updateParams = {
                TableName: TABLE_NAME,
                Key: marshall({
                    PK: alert.PK,
                    SK: alert.SK
                }),
                UpdateExpression: 'SET is_dismissed = :isDismissed, updatedAt = :updatedAt',
                ExpressionAttributeValues: marshall({
                    ':isDismissed': true,
                    ':updatedAt': new Date().toISOString()
                })
            };
            
            return dynamoDb.send(new UpdateItemCommand(updateParams));
        });
        
        await Promise.all(updatePromises);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                message: `Dismissed ${alertsToUpdate.length} alerts for ${month}`,
                count: alertsToUpdate.length
            })
        };
    }
}