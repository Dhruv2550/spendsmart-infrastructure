const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  QueryCommand, 
  PutCommand, 
  ScanCommand,
  BatchWriteCommand,
  DeleteCommand,
  UpdateCommand
} = require('@aws-sdk/lib-dynamodb');

const client = new DynamoDBClient({});
const dynamodb = DynamoDBDocumentClient.from(client);
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

const corsHeaders = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-ID'
};

const createResponse = (statusCode, body) => ({
  statusCode,
  headers: corsHeaders,
  body: JSON.stringify(body)
});

const extractUserId = (event) => {
  // Try X-User-ID header first
  const userIdHeader = event.headers['X-User-ID'] || event.headers['x-user-id'];
  if (userIdHeader) {
    return userIdHeader;
  }
  
  // Try Authorization Bearer token
  const authHeader = event.headers['Authorization'] || event.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }
  
  return null;
};

// Default template categories to create for new users
const getDefaultTemplateCategories = () => [
  { category: 'Food', budget_amount: 500, rollover_enabled: true },
  { category: 'Transportation', budget_amount: 300, rollover_enabled: false },
  { category: 'Entertainment', budget_amount: 200, rollover_enabled: true },
  { category: 'Shopping', budget_amount: 400, rollover_enabled: false },
  { category: 'Bills', budget_amount: 800, rollover_enabled: false },
  { category: 'Healthcare', budget_amount: 150, rollover_enabled: true }
];

exports.handler = async (event) => {
  console.log('Event:', JSON.stringify(event, null, 2));
  
  if (event.httpMethod === 'OPTIONS') {
    return createResponse(200, {});
  }
  
  try {
    const { httpMethod, pathParameters, resource } = event;
    
    // Extract and validate user ID
    const userId = extractUserId(event);
    if (!userId) {
      return createResponse(401, { error: 'Unauthorized: User ID required' });
    }
    
    console.log('Processing budgets request for user:', userId);
    
    // Handle PUT requests for updating budgets
    if (httpMethod === 'PUT') {
      return await updateEnvelopeBudget(event, userId);
    }
    
    // Handle DELETE requests for budget templates
    if (httpMethod === 'DELETE' && resource.includes('/budget-templates/')) {
      return await handleDeleteTemplate(pathParameters, userId);
    }
    
    // Handle different routes
    if (resource.includes('/budget-analysis/')) {
      return await handleBudgetAnalysis(pathParameters, userId);
    } else if (resource.includes('/budgets/')) {
      return await handleBudgets(pathParameters, userId);
    }
    
    return createResponse(404, { error: 'Route not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};

async function updateEnvelopeBudget(event, userId) {
  const { template, month } = event.pathParameters;
  const decodedTemplate = decodeURIComponent(template);
  const decodedMonth = decodeURIComponent(month);
  
  let requestData;
  try {
    requestData = JSON.parse(event.body);
  } catch (error) {
    return createResponse(400, { error: 'Invalid JSON in request body' });
  }
  
  const { budgets } = requestData;
  
  if (!budgets || !Array.isArray(budgets)) {
    return createResponse(400, { error: 'Missing budgets array' });
  }
  
  const updatePromises = [];
  
  for (const budget of budgets) {
    const updateParams = {
      TableName: TABLE_NAME,
      Key: {
        PK: `USER#${userId}#ENVELOPE#${decodedTemplate}`,
        SK: `${decodedMonth}#${budget.category}`
      },
      UpdateExpression: 'SET budget_amount = :amount',
      ExpressionAttributeValues: {
        ':amount': parseFloat(budget.budget_amount)
      }
    };
    
    updatePromises.push(dynamodb.send(new UpdateCommand(updateParams)));
  }
  
  try {
    await Promise.all(updatePromises);
    console.log(`Updated ${budgets.length} budgets for user ${userId}, template ${decodedTemplate}, month ${decodedMonth}`);
    return createResponse(200, { message: 'Budgets updated successfully' });
  } catch (error) {
    console.error('Error updating budgets for user', userId, ':', error);
    return createResponse(500, { error: 'Failed to update budgets' });
  }
}

async function handleDeleteTemplate(pathParameters, userId) {
  const templateName = decodeURIComponent(pathParameters?.templateName || '');
  console.log('Deleting template for user', userId, ':', templateName);
  
  if (!templateName) {
    return createResponse(400, { error: 'Missing template name' });
  }
  
  try {
    // First, get all categories for this template - USER FILTERED
    const getParams = {
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `USER#${userId}#TEMPLATE#${templateName}`
      }
    };
    
    const result = await dynamodb.send(new QueryCommand(getParams));
    
    // Delete all categories for this template
    if (result.Items && result.Items.length > 0) {
      const deletePromises = result.Items.map(item => {
        const deleteParams = {
          TableName: TABLE_NAME,
          Key: {
            PK: item.PK,
            SK: item.SK
          }
        };
        return dynamodb.send(new DeleteCommand(deleteParams));
      });
      
      await Promise.all(deletePromises);
      console.log(`Successfully deleted ${result.Items.length} categories for template: ${templateName} for user ${userId}`);
    }
    
    return createResponse(200, { 
      message: 'Template deleted successfully',
      deletedItems: result.Items?.length || 0
    });
    
  } catch (error) {
    console.error('Error deleting template for user', userId, ':', error);
    return createResponse(500, { 
      error: 'Failed to delete template',
      details: error.message 
    });
  }
}

async function handleBudgets(pathParameters, userId) {
  const template = decodeURIComponent(pathParameters?.template || '');
  const month = decodeURIComponent(pathParameters?.month || '');
  
  console.log('User', userId, '- Decoded template:', template);
  console.log('User', userId, '- Decoded month:', month);
  
  if (!template || !month) {
    return createResponse(400, { error: 'Missing template or month parameter' });
  }
  
  // Get or create envelope budgets for this template/month - USER FILTERED
  const budgets = await getOrCreateEnvelopeBudgets(template, month, userId);
  
  return createResponse(200, budgets);
}

async function handleBudgetAnalysis(pathParameters, userId) {
  const template = decodeURIComponent(pathParameters?.template || '');
  const month = decodeURIComponent(pathParameters?.month || '');
  
  console.log('Analysis for user', userId, '- Decoded template:', template);
  console.log('Analysis for user', userId, '- Decoded month:', month);
  
  if (!template || !month) {
    return createResponse(400, { error: 'Missing template or month parameter' });
  }
  
  // Get envelope budgets - USER FILTERED
  const budgets = await getOrCreateEnvelopeBudgets(template, month, userId);
  
  // Get actual spending for this month - USER FILTERED
  const actualSpending = await getActualSpending(month, userId);
  
  // Calculate analysis
  const analysis = calculateBudgetAnalysis(budgets, actualSpending);
  
  return createResponse(200, {
    analysis: analysis.categoryAnalysis,
    summary: analysis.summary
  });
}

async function getOrCreateEnvelopeBudgets(template, month, userId) {
  // First, check if envelope budgets already exist for this template/month - USER FILTERED
  const existingBudgetsParams = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND #month = :month',
    ExpressionAttributeNames: {
      '#month': 'month'
    },
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#ENVELOPE#${template}`,
      ':month': month
    }
  };
  
  try {
    const existingResult = await dynamodb.send(new ScanCommand(existingBudgetsParams));
    
    if (existingResult.Items && existingResult.Items.length > 0) {
      console.log('Found existing envelope budgets for user', userId, ':', existingResult.Items.length);
      // Return existing envelope budgets
      return existingResult.Items.map(item => ({
        id: item.id,
        template_name: item.template_name,
        category: item.category,
        budget_amount: item.budget_amount,
        month: item.month,
        rollover_enabled: item.rollover_enabled,
        rollover_amount: item.rollover_amount || 0,
        is_active: item.is_active,
        created_at: item.created_at
      }));
    }
    
    console.log('No existing envelope budgets found for user', userId, ', creating from template');
    // If no envelope budgets exist, create them from the template
    return await createEnvelopeBudgetsFromTemplate(template, month, userId);
    
  } catch (error) {
    console.error('Error in getOrCreateEnvelopeBudgets for user', userId, ':', error);
    throw error;
  }
}

async function createDefaultTemplate(templateName, userId) {
  console.log(`Creating default "${templateName}" template for new user:`, userId);
  
  const defaultCategories = getDefaultTemplateCategories();
  const timestamp = new Date().toISOString();
  
  const writeRequests = [];
  
  for (const categoryData of defaultCategories) {
    const templateItem = {
      PK: `USER#${userId}#TEMPLATE#${templateName}`,
      SK: `CATEGORY#${categoryData.category}`,
      GSI1PK: `USER#${userId}#TEMPLATE_CATEGORY#${categoryData.category}`,
      GSI1SK: `${templateName}#${categoryData.category}`,
      template_name: templateName,
      category: categoryData.category,
      budget_amount: categoryData.budget_amount,
      rollover_enabled: categoryData.rollover_enabled,
      is_active: true,
      created_at: timestamp,
      user_id: userId
    };
    
    writeRequests.push({
      PutRequest: { Item: templateItem }
    });
  }
  
  // Write the template items in chunks
  const chunks = [];
  for (let i = 0; i < writeRequests.length; i += 25) {
    chunks.push(writeRequests.slice(i, i + 25));
  }
  
  for (const chunk of chunks) {
    await dynamodb.send(new BatchWriteCommand({
      RequestItems: {
        [TABLE_NAME]: chunk
      }
    }));
  }
  
  console.log(`Successfully created default "${templateName}" template with ${defaultCategories.length} categories for user ${userId}`);
  return defaultCategories;
}

async function createEnvelopeBudgetsFromTemplate(template, month, userId) {
  console.log('Looking for template for user', userId, ':', template);
  
  // Get template categories - USER FILTERED
  const templateParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#TEMPLATE#${template}`
    }
  };
  
  try {
    const templateResult = await dynamodb.send(new QueryCommand(templateParams));
    console.log('Template query result for user', userId, ':', templateResult.Items?.length || 0, 'items found');
    
    let templateCategories;
    
    if (!templateResult.Items || templateResult.Items.length === 0) {
      // Check what templates actually exist for this user
      const allTemplatesParams = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: {
          ':pk': `USER#${userId}#TEMPLATE#`
        }
      };
      
      const allTemplates = await dynamodb.send(new ScanCommand(allTemplatesParams));
      const templateNames = [...new Set(allTemplates.Items?.map(item => item.template_name) || [])];
      
      console.log('Available templates for user', userId, ':', templateNames);
      
      // If this is a "Default" template request and no templates exist, create one automatically
      if (template === 'Default' && templateNames.length === 0) {
        console.log('No templates found for new user. Creating default template automatically...');
        const defaultCategories = await createDefaultTemplate('Default', userId);
        
        // Convert to template format for envelope creation
        templateCategories = defaultCategories.map(cat => ({
          template_name: 'Default',
          category: cat.category,
          budget_amount: cat.budget_amount,
          rollover_enabled: cat.rollover_enabled
        }));
      } else {
        // Template not found and it's not a default template scenario
        throw new Error(`Template "${template}" not found. Available templates: ${templateNames.join(', ')}`);
      }
    } else {
      // Use existing template
      templateCategories = templateResult.Items;
    }
    
    // Calculate rollover amounts from previous month - USER FILTERED
    const previousMonth = getPreviousMonth(month);
    const rolloverAmounts = await calculateRolloverAmounts(template, previousMonth, userId);
    
    const timestamp = new Date().toISOString();
    const envelopeBudgets = [];
    const writeRequests = [];
    
    for (const templateItem of templateCategories) {
      const id = `${template}-${month}-${templateItem.category}-${Date.now()}`;
      const rolloverAmount = rolloverAmounts[templateItem.category] || 0;
      
      const envelopeBudget = {
        PK: `USER#${userId}#ENVELOPE#${template}`,
        SK: `${month}#${templateItem.category}`,
        GSI1PK: `USER#${userId}#ENVELOPE_MONTH#${month}`,
        GSI1SK: `${template}#${templateItem.category}`,
        id,
        template_name: template,
        category: templateItem.category,
        budget_amount: templateItem.budget_amount,
        month,
        rollover_enabled: templateItem.rollover_enabled,
        rollover_amount: rolloverAmount,
        is_active: true,
        created_at: timestamp,
        user_id: userId
      };
      
      envelopeBudgets.push({
        id: envelopeBudget.id,
        template_name: envelopeBudget.template_name,
        category: envelopeBudget.category,
        budget_amount: envelopeBudget.budget_amount,
        month: envelopeBudget.month,
        rollover_enabled: envelopeBudget.rollover_enabled,
        rollover_amount: envelopeBudget.rollover_amount,
        is_active: envelopeBudget.is_active,
        created_at: envelopeBudget.created_at
      });
      
      writeRequests.push({
        PutRequest: { Item: envelopeBudget }
      });
    }
    
    // Batch write envelope budgets
    if (writeRequests.length > 0) {
      console.log('Writing', writeRequests.length, 'envelope budgets for user', userId);
      const chunks = [];
      for (let i = 0; i < writeRequests.length; i += 25) {
        chunks.push(writeRequests.slice(i, i + 25));
      }
      
      for (const chunk of chunks) {
        await dynamodb.send(new BatchWriteCommand({
          RequestItems: {
            [TABLE_NAME]: chunk
          }
        }));
      }
    }
    
    console.log('Successfully created', envelopeBudgets.length, 'envelope budgets for user', userId);
    return envelopeBudgets;
    
  } catch (error) {
    console.error('Error creating envelope budgets from template for user', userId, ':', error);
    throw error;
  }
}

async function getActualSpending(month, userId) {
  // Use scan with filter to find transactions for the month - USER FILTERED
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :userPk) AND begins_with(GSI1PK, :monthPrefix) AND #type = :type',
    ExpressionAttributeNames: {
      '#type': 'type'
    },
    ExpressionAttributeValues: {
      ':userPk': `USER#${userId}#TRANSACTION`,
      ':monthPrefix': `MONTH#${month}`,
      ':type': 'Expense'
    }
  };
  
  try {
    const result = await dynamodb.send(new ScanCommand(params));
    
    const spendingByCategory = {};
    
    if (result.Items) {
      result.Items.forEach(item => {
        if (!spendingByCategory[item.category]) {
          spendingByCategory[item.category] = 0;
        }
        spendingByCategory[item.category] += parseFloat(item.amount);
      });
    }
    
    console.log('Actual spending by category for user', userId, ':', spendingByCategory);
    return spendingByCategory;
    
  } catch (error) {
    console.error('Error getting actual spending for user', userId, ':', error);
    return {};
  }
}

async function calculateRolloverAmounts(template, previousMonth, userId) {
  // Only get existing envelope budgets, don't create them - USER FILTERED
  const existingBudgetsParams = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND #month = :month',
    ExpressionAttributeNames: {
      '#month': 'month'
    },
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#ENVELOPE#${template}`,
      ':month': previousMonth
    }
  };
  
  try {
    const existingResult = await dynamodb.send(new ScanCommand(existingBudgetsParams));
    
    // If no previous budgets exist, return empty rollover amounts
    if (!existingResult.Items || existingResult.Items.length === 0) {
      console.log('No previous month budgets found for rollover calculation for user', userId);
      return {};
    }
    
    // Get previous month's spending - USER FILTERED
    const previousSpending = await getActualSpending(previousMonth, userId);
    
    const rolloverAmounts = {};
    
    existingResult.Items.forEach(budget => {
      if (budget.rollover_enabled) {
        const spent = previousSpending[budget.category] || 0;
        const remaining = budget.budget_amount - spent + (budget.rollover_amount || 0);
        if (remaining > 0) {
          rolloverAmounts[budget.category] = remaining;
        }
      }
    });
    
    console.log('Calculated rollover amounts for user', userId, ':', rolloverAmounts);
    return rolloverAmounts;
    
  } catch (error) {
    console.error('Error calculating rollover amounts for user', userId, ':', error);
    return {};
  }
}

function calculateBudgetAnalysis(budgets, actualSpending) {
  const categoryAnalysis = [];
  let totalBudgeted = 0;
  let totalActual = 0;
  let overBudgetCategories = 0;
  
  // Analyze each budget category
  budgets.forEach(budget => {
    const actual = actualSpending[budget.category] || 0;
    const totalBudgetAmount = budget.budget_amount + budget.rollover_amount;
    const remaining = totalBudgetAmount - actual;
    const percentage = totalBudgetAmount > 0 ? (actual / totalBudgetAmount) * 100 : 0;
    
    if (actual > totalBudgetAmount) {
      overBudgetCategories++;
    }
    
    totalBudgeted += totalBudgetAmount;
    totalActual += actual;
    
    categoryAnalysis.push({
      category: budget.category,
      budgeted: totalBudgetAmount,
      actual: actual,
      remaining: remaining,
      percentage: Math.round(percentage * 100) / 100,
      rollover_enabled: budget.rollover_enabled,
      rollover_amount: budget.rollover_amount,
      has_budget: true,
      unbudgeted_spending: false
    });
  });
  
  // Check for unbudgeted spending
  const budgetedCategories = budgets.map(b => b.category);
  Object.keys(actualSpending).forEach(category => {
    if (!budgetedCategories.includes(category)) {
      const actual = actualSpending[category];
      totalActual += actual;
      
      categoryAnalysis.push({
        category: category,
        budgeted: 0,
        actual: actual,
        remaining: -actual,
        percentage: 0,
        rollover_enabled: false,
        rollover_amount: 0,
        has_budget: false,
        unbudgeted_spending: true
      });
    }
  });
  
  const totalRemaining = totalBudgeted - totalActual;
  const budgetUtilization = totalBudgeted > 0 ? (totalActual / totalBudgeted) * 100 : 0;
  
  const summary = {
    totalBudgeted: Math.round(totalBudgeted * 100) / 100,
    totalActual: Math.round(totalActual * 100) / 100,
    totalRemaining: Math.round(totalRemaining * 100) / 100,
    overBudgetCategories,
    budgetUtilization: Math.round(budgetUtilization * 100) / 100
  };
  
  return {
    categoryAnalysis,
    summary
  };
}

function getPreviousMonth(monthStr) {
  const [year, month] = monthStr.split('-').map(Number);
  const date = new Date(year, month - 1, 1);
  date.setMonth(date.getMonth() - 1);
  
  const prevYear = date.getFullYear();
  const prevMonth = String(date.getMonth() + 1).padStart(2, '0');
  
  return `${prevYear}-${prevMonth}`;
}