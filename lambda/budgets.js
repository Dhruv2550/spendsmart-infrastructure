const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  QueryCommand, 
  PutCommand, 
  ScanCommand,
  BatchWriteCommand
} = require('@aws-sdk/lib-dynamodb');

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
    const { httpMethod, pathParameters, resource } = event;
    
    // Handle different routes
    if (resource.includes('/budget-analysis/')) {
      return await handleBudgetAnalysis(pathParameters);
    } else if (resource.includes('/budgets/')) {
      return await handleBudgets(pathParameters);
    }
    
    return createResponse(404, { error: 'Route not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};

async function handleBudgets(pathParameters) {
  const { template, month } = pathParameters;
  
  if (!template || !month) {
    return createResponse(400, { error: 'Missing template or month parameter' });
  }
  
  // Get or create envelope budgets for this template/month
  const budgets = await getOrCreateEnvelopeBudgets(template, month);
  
  return createResponse(200, budgets);
}

async function handleBudgetAnalysis(pathParameters) {
  const { template, month } = pathParameters;
  
  if (!template || !month) {
    return createResponse(400, { error: 'Missing template or month parameter' });
  }
  
  // Get envelope budgets
  const budgets = await getOrCreateEnvelopeBudgets(template, month);
  
  // Get actual spending for this month
  const actualSpending = await getActualSpending(month);
  
  // Calculate analysis
  const analysis = calculateBudgetAnalysis(budgets, actualSpending);
  
  return createResponse(200, {
    analysis: analysis.categoryAnalysis,
    summary: analysis.summary
  });
}

async function getOrCreateEnvelopeBudgets(template, month) {
  // First, check if envelope budgets already exist for this template/month
  const existingBudgetsParams = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND #month = :month',
    ExpressionAttributeNames: {
      '#month': 'month'
    },
    ExpressionAttributeValues: {
      ':pk': `ENVELOPE#${template}`,
      ':month': month
    }
  };
  
  const existingResult = await dynamodb.send(new ScanCommand(existingBudgetsParams));
  
  if (existingResult.Items && existingResult.Items.length > 0) {
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
  
  // If no envelope budgets exist, create them from the template
  return await createEnvelopeBudgetsFromTemplate(template, month);
}

async function createEnvelopeBudgetsFromTemplate(template, month) {
  // Get template categories
  const templateParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `TEMPLATE#${template}`
    }
  };
  
  const templateResult = await dynamodb.send(new QueryCommand(templateParams));
  
  if (!templateResult.Items || templateResult.Items.length === 0) {
    throw new Error(`Template "${template}" not found`);
  }
  
  // Calculate rollover amounts from previous month
  const previousMonth = getPreviousMonth(month);
  const rolloverAmounts = await calculateRolloverAmounts(template, previousMonth);
  
  const timestamp = new Date().toISOString();
  const envelopeBudgets = [];
  const writeRequests = [];
  
  for (const templateItem of templateResult.Items) {
    const id = `${template}-${month}-${templateItem.category}-${Date.now()}`;
    const rolloverAmount = rolloverAmounts[templateItem.category] || 0;
    
    const envelopeBudget = {
      PK: `ENVELOPE#${template}`,
      SK: `${month}#${templateItem.category}`,
      GSI1PK: `ENVELOPE_MONTH#${month}`,
      GSI1SK: `${template}#${templateItem.category}`,
      id,
      template_name: template,
      category: templateItem.category,
      budget_amount: templateItem.budget_amount,
      month,
      rollover_enabled: templateItem.rollover_enabled,
      rollover_amount: rolloverAmount,
      is_active: true,
      created_at: timestamp
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
  
  return envelopeBudgets;
}

async function getActualSpending(month) {
  const params = {
    TableName: TABLE_NAME,
    IndexName: 'GSI1',
    KeyConditionExpression: 'GSI1PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `MONTH#${month}`
    }
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  
  // Group spending by category
  const spendingByCategory = {};
  
  if (result.Items) {
    result.Items.forEach(item => {
      if (item.type === 'expense') {
        if (!spendingByCategory[item.category]) {
          spendingByCategory[item.category] = 0;
        }
        spendingByCategory[item.category] += item.amount;
      }
    });
  }
  
  return spendingByCategory;
}

async function calculateRolloverAmounts(template, previousMonth) {
  // Only get existing envelope budgets, don't create them
  const existingBudgetsParams = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND #month = :month',
    ExpressionAttributeNames: {
      '#month': 'month'
    },
    ExpressionAttributeValues: {
      ':pk': `ENVELOPE#${template}`,
      ':month': previousMonth
    }
  };
  
  const existingResult = await dynamodb.send(new ScanCommand(existingBudgetsParams));
  
  // If no previous budgets exist, return empty rollover amounts
  if (!existingResult.Items || existingResult.Items.length === 0) {
    return {};
  }
  
  // Get previous month's spending
  const previousSpending = await getActualSpending(previousMonth);
  
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
  
  return rolloverAmounts;
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