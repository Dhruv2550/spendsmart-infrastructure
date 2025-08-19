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
    
    console.log('Processing recurring transactions request for user:', userId);
    
    // Route handling for recurring transactions
    if (resource === '/api/recurring') {
      if (httpMethod === 'GET') {
        return await getAllRecurringTransactions(userId);
      } else if (httpMethod === 'POST') {
        return await createRecurringTransaction(JSON.parse(event.body), userId);
      }
    }
    
    if (resource === '/api/recurring/{id}') {
      const { id } = pathParameters;
      if (httpMethod === 'GET') {
        return await getRecurringTransaction(id, userId);
      } else if (httpMethod === 'PUT') {
        return await updateRecurringTransaction(id, JSON.parse(event.body), userId);
      } else if (httpMethod === 'DELETE') {
        return await deleteRecurringTransaction(id, userId);
      }
    }
    
    if (resource === '/api/recurring/{id}/toggle') {
      const { id } = pathParameters;
      if (httpMethod === 'PUT') {
        return await toggleRecurringTransaction(id, userId);
      }
    }
    
    if (resource === '/api/recurring/{id}/execute') {
      const { id } = pathParameters;
      if (httpMethod === 'POST') {
        return await executeRecurringTransaction(id, userId);
      }
    }
    
    if (resource === '/api/recurring/execute-due') {
      if (httpMethod === 'POST') {
        return await executeDueTransactions(userId);
      }
    }
    
    if (resource === '/api/recurring/upcoming') {
      if (httpMethod === 'GET') {
        const days = event.queryStringParameters?.days || 7;
        return await getUpcomingTransactions(parseInt(days), userId);
      }
    }
    
    return createResponse(404, { error: 'Route not found' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};

// Get all recurring transactions - USER FILTERED
async function getAllRecurringTransactions(userId) {
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk)',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#`
    }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  
  const transactions = result.Items?.map(formatRecurringTransaction) || [];
  
  console.log(`Retrieved ${transactions.length} recurring transactions for user ${userId}`);
  return createResponse(200, transactions);
}

// Create new recurring transaction - USER SCOPED
async function createRecurringTransaction(data, userId) {
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
  const nextExecution = data.next_execution || start_date;
  
  const recurringTransaction = {
    PK: `USER#${userId}#RECURRING#${id}`,
    SK: 'METADATA',
    GSI1PK: `USER#${userId}#RECURRING_ACTIVE`,
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
    updated_at: timestamp,
    user_id: userId
  };
  
  await dynamodb.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: recurringTransaction
  }));
  
  console.log(`Created recurring transaction ${id} for user ${userId}`);
  
  return createResponse(201, {
    message: 'Recurring transaction created successfully',
    transaction: formatRecurringTransaction(recurringTransaction)
  });
}

// Get specific recurring transaction - USER FILTERED
async function getRecurringTransaction(id, userId) {
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#${id}`
    }
  };
  
  const result = await dynamodb.send(new QueryCommand(params));
  
  if (!result.Items || result.Items.length === 0) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  console.log(`Retrieved recurring transaction ${id} for user ${userId}`);
  return createResponse(200, formatRecurringTransaction(result.Items[0]));
}

// Update recurring transaction - USER FILTERED
async function updateRecurringTransaction(id, data, userId) {
  const timestamp = new Date().toISOString();
  
  // Build update expression dynamically
  let updateExpression = 'SET updated_at = :timestamp';
  let expressionAttributeValues = {
    ':timestamp': timestamp
  };
  let expressionAttributeNames = {}; // Only add names when needed
  
  if (data.name !== undefined) {
    updateExpression += ', #name = :name';
    expressionAttributeNames['#name'] = 'name';
    expressionAttributeValues[':name'] = data.name;
  }
  
  if (data.amount !== undefined) {
    updateExpression += ', amount = :amount';
    expressionAttributeValues[':amount'] = parseFloat(data.amount);
  }
  
  if (data.category !== undefined) {
    updateExpression += ', category = :category';
    expressionAttributeValues[':category'] = data.category;
  }
  
  if (data.type !== undefined) {
    updateExpression += ', #type = :type';
    expressionAttributeNames['#type'] = 'type';
    expressionAttributeValues[':type'] = data.type;
  }
  
  if (data.frequency !== undefined) {
    updateExpression += ', frequency = :frequency';
    expressionAttributeValues[':frequency'] = data.frequency;
  }
  
  if (data.start_date !== undefined) {
    updateExpression += ', start_date = :start_date';
    expressionAttributeValues[':start_date'] = data.start_date;
  }
  
  if (data.end_date !== undefined) {
    updateExpression += ', end_date = :end_date';
    expressionAttributeValues[':end_date'] = data.end_date;
  }
  
  if (data.description !== undefined) {
    updateExpression += ', description = :description';
    expressionAttributeValues[':description'] = data.description;
  }
  
  if (data.is_active !== undefined) {
    updateExpression += ', is_active = :is_active';
    expressionAttributeValues[':is_active'] = data.is_active;
  }
  
  // CRITICAL FIX: Add next_execution update
  if (data.next_execution !== undefined) {
    updateExpression += ', next_execution = :next_execution';
    expressionAttributeValues[':next_execution'] = data.next_execution;
  }
  
  const params = {
    TableName: TABLE_NAME,
    Key: {
      PK: `USER#${userId}#RECURRING#${id}`,
      SK: 'METADATA'
    },
    UpdateExpression: updateExpression,
    ExpressionAttributeValues: expressionAttributeValues,
    ReturnValues: 'ALL_NEW'
  };
  
  // Only add ExpressionAttributeNames if we have any
  if (Object.keys(expressionAttributeNames).length > 0) {
    params.ExpressionAttributeNames = expressionAttributeNames;
  }
  
  console.log('Updating recurring transaction for user', userId, '- params:', JSON.stringify(params, null, 2));
  
  const result = await dynamodb.send(new UpdateCommand(params));
  
  if (!result.Attributes) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  console.log(`Updated recurring transaction ${id} for user ${userId}`);
  
  return createResponse(200, {
    message: 'Recurring transaction updated successfully',
    transaction: formatRecurringTransaction(result.Attributes)
  });
}

// Delete recurring transaction - USER FILTERED
async function deleteRecurringTransaction(id, userId) {
  const params = {
    TableName: TABLE_NAME,
    Key: {
      PK: `USER#${userId}#RECURRING#${id}`,
      SK: 'METADATA'
    },
    ReturnValues: 'ALL_OLD'
  };
  
  const result = await dynamodb.send(new DeleteCommand(params));
  
  if (!result.Attributes) {
    return createResponse(404, { error: 'Recurring transaction not found' });
  }
  
  console.log(`Deleted recurring transaction ${id} for user ${userId}`);
  return createResponse(200, { message: 'Recurring transaction deleted successfully' });
}

// Toggle active status - USER FILTERED
async function toggleRecurringTransaction(id, userId) {
  // First get current status
  const getParams = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#${id}`
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
      PK: `USER#${userId}#RECURRING#${id}`,
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
  
  console.log(`Toggled recurring transaction ${id} to ${newActiveStatus ? 'active' : 'inactive'} for user ${userId}`);
  
  return createResponse(200, {
    message: `Recurring transaction ${newActiveStatus ? 'activated' : 'deactivated'} successfully`,
    transaction: formatRecurringTransaction(result.Attributes)
  });
}

// Execute specific recurring transaction - USER FILTERED
async function executeRecurringTransaction(id, userId) {
  // Get recurring transaction - USER FILTERED
  const params = {
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#${id}`
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
  
  // Create actual transaction - USER SCOPED
  const transactionId = `txn-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toISOString();
  const month = timestamp.substring(0, 7); // YYYY-MM format
  
  const transaction = {
    PK: `USER#${userId}#TRANSACTION`,
    SK: `TRANSACTION#${transactionId}`,
    GSI1PK: `MONTH#${month}`,
    GSI1SK: `${recurringTransaction.category}#${transactionId}`,
    id: transactionId,
    amount: recurringTransaction.amount,
    category: recurringTransaction.category,
    note: `${recurringTransaction.description} (Auto-generated from: ${recurringTransaction.name})`,
    type: recurringTransaction.type,
    date: timestamp.split('T')[0],
    recurring_transaction_id: id,
    created_at: timestamp,
    user_id: userId
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
        PK: `USER#${userId}#RECURRING#${id}`,
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
  
  console.log(`Executed recurring transaction ${id} for user ${userId}, created transaction ${transactionId}`);
  
  return createResponse(200, {
    message: 'Recurring transaction executed successfully',
    transaction: {
      id: transaction.id,
      amount: transaction.amount,
      category: transaction.category,
      note: transaction.note,
      type: transaction.type,
      date: transaction.date,
      created_at: transaction.created_at
    },
    next_execution: nextExecution
  });
}

// Execute all due transactions - USER FILTERED
async function executeDueTransactions(userId) {
  const today = new Date().toISOString().split('T')[0];
  
  // Get all active recurring transactions that are due - USER FILTERED
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND is_active = :active AND next_execution <= :today',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#`,
      ':active': true,
      ':today': today
    }
  };
  
  const result = await dynamodb.send(new ScanCommand(params));
  
  if (!result.Items || result.Items.length === 0) {
    console.log(`No recurring transactions due for execution for user ${userId}`);
    return createResponse(200, { message: 'No recurring transactions due for execution', executed_count: 0 });
  }
  
  const executedTransactions = [];
  
  for (const recurringTransaction of result.Items) {
    try {
      const executeResult = await executeRecurringTransaction(recurringTransaction.id, userId);
      if (executeResult.statusCode === 200) {
        executedTransactions.push(recurringTransaction.name);
      }
    } catch (error) {
      console.error(`Failed to execute recurring transaction ${recurringTransaction.id} for user ${userId}:`, error);
    }
  }
  
  console.log(`Executed ${executedTransactions.length} recurring transactions for user ${userId}`);
  
  return createResponse(200, {
    message: `Executed ${executedTransactions.length} recurring transactions`,
    executed_count: executedTransactions.length,
    executed_transactions: executedTransactions
  });
}

// Get upcoming transactions - USER FILTERED
async function getUpcomingTransactions(days = 7, userId) {
  const today = new Date();
  const futureDate = new Date();
  futureDate.setDate(today.getDate() + days);
  
  const todayStr = today.toISOString().split('T')[0];
  const futureDateStr = futureDate.toISOString().split('T')[0];
  
  const params = {
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pk) AND is_active = :active AND next_execution >= :today AND next_execution <= :future',
    ExpressionAttributeValues: {
      ':pk': `USER#${userId}#RECURRING#`,
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
  
  console.log(`Retrieved ${upcomingTransactions.length} upcoming transactions for user ${userId}`);
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