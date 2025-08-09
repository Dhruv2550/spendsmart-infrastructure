const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, PutCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

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
    
    if (httpMethod === 'GET' && !pathParameters) {
      const params = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: {
          ':pk': 'USER#default#TRANSACTION'
        }
      };
      
      const result = await dynamodb.send(new ScanCommand(params));
      const transactions = result.Items.map((item) => ({
        id: item.id,
        type: item.type,
        category: item.category,
        amount: item.amount,
        note: item.note || '',
        date: item.date
      }));
      
      return createResponse(200, transactions);
    }
    
    if (httpMethod === 'POST') {
      const data = JSON.parse(body || '{}');
      const { type, category, amount, note, date } = data;
      
      if (!type || !category || !amount) {
        return createResponse(400, { error: 'Missing required fields' });
      }
      
      const id = Date.now().toString();
      const item = {
        PK: 'USER#default#TRANSACTION',
        SK: 'TRANSACTION#' + id,
        GSI1PK: 'MONTH#' + (date || new Date().toISOString().substring(0, 7)),
        GSI1SK: category + '#' + id,
        id,
        type,
        category,
        amount: parseFloat(amount),
        note: note || '',
        date: date || new Date().toISOString().split('T')[0],
        created_at: new Date().toISOString()
      };
      
      await dynamodb.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: item
      }));
      
      return createResponse(201, {
        id: item.id,
        type: item.type,
        category: item.category,
        amount: item.amount,
        note: item.note,
        date: item.date
      });
    }
    
    if (httpMethod === 'DELETE' && pathParameters && pathParameters.id) {
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      
      const transactionId = pathParameters.id;
      
      await dynamodb.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {
          PK: 'USER#default#TRANSACTION',
          SK: 'TRANSACTION#' + transactionId
        }
      }));
      
      return createResponse(200, { message: 'Transaction deleted successfully' });
    }
    
    return createResponse(405, { error: 'Method not allowed' });
    
  } catch (error) {
    console.error('Error:', error);
    return createResponse(500, { error: 'Internal server error', details: error.message });
  }
};