const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { 
  DynamoDBDocumentClient, 
  QueryCommand, 
  PutCommand, 
  UpdateCommand,
  DeleteCommand,
  ScanCommand
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
    
    // Route handling for recurring transactions
    if (resource === '/api/recurring') {
      if (httpMethod === 'GET') {
        return await getAllRecurringTransactions();
      } else if (httpMethod === 'POST') {
        return await createRecurringTransaction(JSON.parse(event.body));
      }
    }
    
    if (resource === '/api/recurring/{id}') {
      const { id } = pathParameters;
      if (httpMethod === 'GET') {
        return await getRecurringTransaction(id);
      } else if (httpMethod === 'PUT') {
        return await updateRecurringTransaction(id, JSON.parse(event.body));
      } else if (httpMethod === 'DELETE') {
        return await deleteRecurringTransaction(id);
      }
    }
    
    if (resource === '/api/recurring/{id}/toggle') {
      const { id } = pathParameters;
      if (httpMethod === 'PUT') {
        return await toggleRecurringTransaction(id);
      }
    }
    
    if (resource === '/api/recurring/{id}/execute') {
      const { id } = pathParameters;
      if (httpMethod === 'POST') {
        return await executeRecurringTransaction(id);
      }
    }
    
    if (resource === '/api/recurring/execute-due') {
      if (httpMethod === 'POST') {
        return await executeDueTransactions();
      }
    }
    
    if (resource === '/api/recurring/upcoming') {
      if (httpMethod === 'GET') {
        const days = event.queryStringParameters?.days || 7;
        return await getUpcomingTransactions(parseInt(days));
      }
    }
    
    return createResponse(404, { error: 'Route not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};

// Get all recurring transactions
async function getAllRecurringTransactions() {
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk)',
    ExpressionAttributeValues: {
      ':pk': 'RECURRING#'
    }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  
  const transactions = result.Items?.map(formatRecurringTransaction) || [];
  
  return createResponse(200, transactions);
}

// Create new recurring transaction
async function createRecurringTransaction(data) {
  const {
    name,
    amount,
    category,
    type, // 'income' or 'expense'
    frequency, // 'daily', 'weekly', 'monthly', 'yearly'
    start_date,
    end_date = null,
    description = '',
    is_active = true
  } = data;
  
  // Validation
  if (!name || !amount || !category || !type || !frequency || !start_date) {
    return createResponse(400, { 
      error: 'Missing required fields: name, amount, category, type, frequency, start_date' 
    });
  }
  
  if (!['income', 'expense'].includes(type)) {
    return createResponse(400, { error: 'Type must be "income" or "expense"' });
  }
  
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) {
    return createResponse(400, { error: 'Frequency must be daily, weekly, monthly, or yearly' });
  }
  
  const id = `recurring-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toISOString();
  
  // Calculate next execution date
  const nextExecution = calculateNextExecution(start_date, frequency);
  
  const recurringTransaction = {
    PK: `RECURRING#${id}`,
    SK: 'METADATA',
    GSI1PK: 'RECURRING_ACTIVE',
    GSI1SK: is_active ? `${nextExecution}#${id}` : `INACTIVE#${id}`,
    id,
    name,
    amount: parseFloat(amount),
    category,
    type,
    frequency,
    start_date,
    end_date,
    description,
    is_active,
    next_execution: nextExecution,
    last_executed: null,
    execution_count: 0,
    created_at: timestamp,
    updated_at: timestamp
  };
  
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: recurringTransaction
  }));
  
  return createResponse(201, {
    message: 'Recurring transaction created successfully',
    transaction: formatRecurringTransaction(recurringTransaction)
  });
}

// Get specific recurring transaction
async function getRecurringTransaction(id) {
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `RECURRING#${id}`
    }
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  
  if (!result.Items || result.Items.length === 0) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  return createResponse(200, formatRecurringTransaction(result.Items[0]));
}

// Update recurring transaction
async function updateRecurringTransaction(id, data) {
  const {
    name,
    amount,
    category,
    type,
    frequency,
    start_date,
    end_date,
    description,
    is_active
  } = data;
  
  const timestamp = new Date().toISOString();
  
  // Build update expression
  let updateExpression = 'SET updated_at = :timestamp';
  let expressionAttributeValues = {
    ':timestamp': timestamp
  };
  
  if (name !== undefined) {
    updateExpression += ', #name = :name';
    expressionAttributeValues[':name'] = name;
  }
  
  if (amount !== undefined) {
    updateExpression += ', amount = :amount';
    expressionAttributeValues[':amount'] = parseFloat(amount);
  }
  
  if (category !== undefined) {
    updateExpression += ', category = :category';
    expressionAttributeValues[':category'] = category;
  }
  
  if (type !== undefined) {
    updateExpression += ', #type = :type';
    expressionAttributeValues[':type'] = type;
  }
  
  if (frequency !== undefined) {
    updateExpression += ', frequency = :frequency';
    expressionAttributeValues[':frequency'] = frequency;
  }
  
  if (start_date !== undefined) {
    updateExpression += ', start_date = :start_date';
    expressionAttributeValues[':start_date'] = start_date;
  }
  
  if (end_date !== undefined) {
    updateExpression += ', end_date = :end_date';
    expressionAttributeValues[':end_date'] = end_date;
  }
  
  if (description !== undefined) {
    updateExpression += ', description = :description';
    expressionAttributeValues[':description'] = description;
  }
  
  if (is_active !== undefined) {
    updateExpression += ', is_active = :is_active';
    expressionAttributeValues[':is_active'] = is_active;
  }
  
  const params = {
    TableName: TABLE_NAME,
    Key: {
      PK: `RECURRING#${id}`,
      SK: 'METADATA'
    },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ExpressionAttributeNames: {
      '#name': 'name',
      '#type': 'type'
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(params));
  
  if (!result.Attributes) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  return createResponse(200, {
    message: 'Recurring transaction updated successfully',
    transaction: formatRecurringTransaction(result.Attributes)
  });
}

// Delete recurring transaction
async function deleteRecurringTransaction(id) {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      PK: `RECURRING#${id}`,
      SK: 'METADATA'
    },
    ReturnValues: 'ALL_OLD'
  };
  
  const result = await dynamodb.send(new DeleteCommand(params));
  
  if (!result.Attributes) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  return createResponse(200, { message: 'Recurring transaction deleted successfully' });
}

// Toggle active status
async function toggleRecurringTransaction(id) {
  // First get current status
  const getParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `RECURRING#${id}`
    }
  };
  
  const getResult = await dynamodb.send(new QueryCommand(getParams));
  
  if (!getResult.Items || getResult.Items.length === 0) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  const currentTransaction = getResult.Items[0];
  const newActiveStatus = !currentTransaction.is_active;
  
  const updateParams = {
    TableName: TABLE_NAME,
    Key: {
      PK: `RECURRING#${id}`,
      SK: 'METADATA'
    },
    UpdateExpression: 'SET is_active = :is_active, updated_at = :timestamp',
    ExpressionAttributeValues: {
      ':is_active': newActiveStatus,
      ':timestamp': new Date().toISOString()
    },
    ReturnValues: 'ALL_NEW'
  };
  
  const result = await dynamodb.send(new UpdateCommand(updateParams));
  
  return createResponse(200, {
    message: `Recurring transaction ${newActiveStatus ? 'activated' : 'deactivated'} successfully`,
    transaction: formatRecurringTransaction(result.Attributes)
  });
}

// Execute specific recurring transaction
async function executeRecurringTransaction(id) {
  // Get recurring transaction
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `RECURRING#${id}`
    }
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  
  if (!result.Items || result.Items.length === 0) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  const recurringTransaction = result.Items[0];
  
  if (!recurringTransaction.is_active) {
    return createResponse(400, { error: 'Cannot execute inactive recurring transaction' });
  }
  
  // Create actual transaction
  const transactionId = `txn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toISOString();
  const month = timestamp.substring(0, 7); // YYYY-MM format
  
  const transaction = {
    PK: `TRANSACTION#${transactionId}`,
    SK: timestamp,
    GSI1PK: `MONTH#${month}`,
    GSI1SK: timestamp,
    id: transactionId,
    amount: recurringTransaction.amount,
    category: recurringTransaction.category,
    description: `${recurringTransaction.description} (Auto-generated from: ${recurringTransaction.name})`,
    type: recurringTransaction.type,
    date: timestamp.split('T')[0],
    recurring_transaction_id: id,
    created_at: timestamp
  };
  
  // Update recurring transaction
  const nextExecution = calculateNextExecution(timestamp.split('T')[0], recurringTransaction.frequency);
  
  await Promise.all([
    // Create the transaction
    dynamodb.send(new PutCommand({
      TableName: TABLE_NAME,
      Item: transaction
    })),
    
    // Update recurring transaction
    dynamodb.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: `RECURRING#${id}`,
        SK: 'METADATA'
      },
      UpdateExpression: 'SET last_executed = :last_executed, next_execution = :next_execution, execution_count = execution_count + :one, updated_at = :timestamp',
      ExpressionAttributeValues: {
        ':last_executed': timestamp.split('T')[0],
        ':next_execution': nextExecution,
        ':one': 1,
        ':timestamp': timestamp
      }
    }))
  ]);
  
  return createResponse(200, {
    message: 'Recurring transaction executed successfully',
    transaction: {
      id: transaction.id,
      amount: transaction.amount,
      category: transaction.category,
      description: transaction.description,
      type: transaction.type,
      date: transaction.date,
      created_at: transaction.created_at
    },
    next_execution: nextExecution
  });
}

// Execute all due transactions
async function executeDueTransactions() {
  const today = new Date().toISOString().split('T')[0];
  
  // Get all active recurring transactions that are due
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND is_active = :active AND next_execution <= :today',
    ExpressionAttributeValues: {
      ':pk': 'RECURRING#',
      ':active': true,
      ':today': today
    }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  
  if (!result.Items || result.Items.length === 0) {
    return createResponse(200, { message: 'No recurring transactions due for execution', executed_count: 0 });
  }
  
  const executedTransactions = [];
  
  for (const recurringTransaction of result.Items) {
    try {
      const executeResult = await executeRecurringTransaction(recurringTransaction.id);
      if (executeResult.statusCode === 200) {
        executedTransactions.push(recurringTransaction.name);
      }
    } catch (error) {
      console.error(`Failed to execute recurring transaction ${recurringTransaction.id}:`, error);
    }
  }
  
  return createResponse(200, {
    message: `Executed ${executedTransactions.length} recurring transactions`,
    executed_count: executedTransactions.length,
    executed_transactions: executedTransactions
  });
}

// Get upcoming transactions
async function getUpcomingTransactions(days = 7) {
  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + days);
  
  const todayStr = today.toISOString().split('T')[0];
  const futureDateStr = futureDate.toISOString().split('T')[0];
  
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND is_active = :active AND next_execution >= :today AND next_execution <= :future',
    ExpressionAttributeValues: {
      ':pk': 'RECURRING#',
      ':active': true,
      ':today': todayStr,
      ':future': futureDateStr
    }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  
  const upcomingTransactions = result.Items?.map(item => ({
    id: item.id,
    name: item.name,
    amount: item.amount,
    category: item.category,
    type: item.type,
    frequency: item.frequency,
    next_execution: item.next_execution,
    days_until_execution: Math.ceil((new Date(item.next_execution) - today) / (1000 * 60 * 60 * 24))
  })) || [];
  
  // Sort by next execution date
  upcomingTransactions.sort((a, b) => new Date(a.next_execution) - new Date(b.next_execution));
  
  return createResponse(200, upcomingTransactions);
}

// Helper Functions
function formatRecurringTransaction(item) {
  return {
    id: item.id,
    name: item.name,
    amount: item.amount,
    category: item.category,
    type: item.type,
    frequency: item.frequency,
    start_date: item.start_date,
    end_date: item.end_date,
    description: item.description,
    is_active: item.is_active,
    next_execution: item.next_execution,
    last_executed: item.last_executed,
    execution_count: item.execution_count,
    created_at: item.created_at,
    updated_at: item.updated_at
  };
}

function calculateNextExecution(fromDate, frequency) {
  const date = new Date(fromDate);
  
  switch (frequency) {
    case 'daily':
      date.setDate(date.getDate() + 1);
      break;
    case 'weekly':
      date.setDate(date.getDate() + 7);
      break;
    case 'monthly':
      date.setMonth(date.getMonth() + 1);
      break;
    case 'yearly':
      date.setFullYear(date.getFullYear() + 1);
      break;
    default:
      throw new Error(`Unknown frequency: ${frequency}`);
  }
  
  return date.toISOString().split('T')[0]; // Return YYYY-MM-DD format
}