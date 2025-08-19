const { DynamoDBClient, ScanCommand, QueryCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoDb = new DynamoDBClient({ region: 'us-east-1' });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

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
    console.log('Analytics event received:', JSON.stringify(event, null, 2));
    
    const headers = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-ID'
    };

    try {
        const { httpMethod } = event;
        
        // Handle preflight requests
        if (httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({ message: 'CORS preflight successful' })
            };
        }

        // Extract and validate user ID
        const userId = extractUserId(event);
        if (!userId) {
            return {
                statusCode: 401,
                headers,
                body: JSON.stringify({ error: 'Unauthorized: User ID required' })
            };
        }

        console.log('Processing analytics request for user:', userId);

        if (httpMethod === 'GET') {
            return await getAnalyticsInsights(headers, userId);
        } else {
            throw new Error(`Unsupported method: ${httpMethod}`);
        }
    } catch (error) {
        console.error('Analytics error:', error);
        return {
            statusCode: error.statusCode || 500,
            headers,
            body: JSON.stringify({
                error: error.message || 'Internal server error'
            })
        };
    }
};

// GET /api/analytics/insights - Get AI-powered spending insights
async function getAnalyticsInsights(headers, userId) {
    console.log('Generating analytics insights for user:', userId);
    
    try {
        // Get all transactions from the last 6 months for this user
        const transactionsData = await getRecentTransactions(userId);
        const transactions = transactionsData.transactions || [];
        
        // Get budget templates for context for this user
        const budgetTemplates = await getBudgetTemplates(userId);
        
        // Generate comprehensive insights
        const insights = await generateInsights(transactions, budgetTemplates);
        
        console.log(`Generated ${insights.length} insights from ${transactions.length} transactions for user ${userId}`);
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                success: true,
                data: {
                    insights: insights,
                    summary: {
                        totalTransactions: transactions.length,
                        analysisDate: new Date().toISOString(),
                        analysisMethod: 'AI-Powered Pattern Recognition'
                    }
                }
            })
        };
        
    } catch (error) {
        console.error('Error generating insights:', error);
        throw error;
    }
}

// Get recent transactions for analysis - USER FILTERED
async function getRecentTransactions(userId) {
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
    
    const params = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: {
            ':pk': { S: `USER#${userId}#TRANSACTION` }
        }
    };

    try {
        const result = await dynamoDb.send(new ScanCommand(params));
        const transactions = result.Items?.map(item => unmarshall(item)) || [];
        
        // Filter to last 6 months and sort by date
        const recentTransactions = transactions
            .filter(t => new Date(t.date) >= sixMonthsAgo)
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        
        console.log(`Retrieved ${recentTransactions.length} recent transactions for user ${userId}`);
        return { transactions: recentTransactions };
    } catch (error) {
        console.error('Error fetching transactions for user', userId, ':', error);
        return { transactions: [] };
    }
}

// Get budget templates for context - USER FILTERED
async function getBudgetTemplates(userId) {
    const params = {
        TableName: TABLE_NAME,
        FilterExpression: 'begins_with(PK, :pk)',
        ExpressionAttributeValues: {
            ':pk': { S: `USER#${userId}#BUDGET` }
        }
    };

    try {
        const result = await dynamoDb.send(new ScanCommand(params));
        const budgetTemplates = result.Items?.map(item => unmarshall(item)) || [];
        console.log(`Retrieved ${budgetTemplates.length} budget templates for user ${userId}`);
        return budgetTemplates;
    } catch (error) {
        console.error('Error fetching budget templates for user', userId, ':', error);
        return [];
    }
}

// Generate AI-powered insights from transaction data
async function generateInsights(transactions, budgetTemplates) {
    const insights = [];
    
    if (transactions.length === 0) {
        return [{
            id: 'no-data',
            type: 'info',
            title: 'Ready to Start Analyzing',
            message: 'Add some transactions to see AI-powered spending insights and recommendations.',
            priority: 'low',
            category: 'general',
            actionable: false
        }];
    }
    
    // 1. Spending trend analysis
    insights.push(...await analyzeSpendingTrends(transactions));
    
    // 2. Category pattern analysis
    insights.push(...await analyzeCategoryPatterns(transactions));
    
    // 3. Budget performance insights
    if (budgetTemplates.length > 0) {
        insights.push(...await analyzeBudgetPerformance(transactions, budgetTemplates));
    }
    
    // 4. Anomaly detection
    insights.push(...await detectSpendingAnomalies(transactions));
    
    // 5. Future predictions
    insights.push(...await generatePredictions(transactions));
    
    // Sort by priority and return top insights
    return insights
        .sort((a, b) => {
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            return priorityOrder[b.priority] - priorityOrder[a.priority];
        })
        .slice(0, 10); // Return top 10 insights
}

// Analyze spending trends over time
async function analyzeSpendingTrends(transactions) {
    const insights = [];
    
    // Group by month
    const monthlySpending = {};
    transactions.forEach(t => {
        const month = new Date(t.date).toISOString().substring(0, 7); // YYYY-MM
        monthlySpending[month] = (monthlySpending[month] || 0) + Math.abs(parseFloat(t.amount) || 0);
    });
    
    const months = Object.keys(monthlySpending).sort();
    if (months.length >= 2) {
        const recent = monthlySpending[months[months.length - 1]];
        const previous = monthlySpending[months[months.length - 2]];
        const change = ((recent - previous) / previous) * 100;
        
        if (change > 20) {
            insights.push({
                id: 'spending-increase',
                type: 'warning',
                title: 'Spending Increased Significantly',
                message: `Your spending increased by ${change.toFixed(1)}% this month compared to last month ($${recent.toFixed(2)} vs $${previous.toFixed(2)}).`,
                priority: 'high',
                category: 'trends',
                actionable: true,
                recommendation: 'Review your recent purchases and consider adjusting your budget categories.'
            });
        } else if (change < -15) {
            insights.push({
                id: 'spending-decrease',
                type: 'success',
                title: 'Great Spending Control',
                message: `You reduced spending by ${Math.abs(change).toFixed(1)}% this month! You saved $${(previous - recent).toFixed(2)}.`,
                priority: 'medium',
                category: 'trends',
                actionable: false
            });
        }
    }
    
    return insights;
}

// Analyze spending patterns by category
async function analyzeCategoryPatterns(transactions) {
    const insights = [];
    
    // Group by category
    const categorySpending = {};
    const categoryCount = {};
    
    transactions.forEach(t => {
        const category = t.category || 'Uncategorized';
        const amount = Math.abs(parseFloat(t.amount) || 0);
        categorySpending[category] = (categorySpending[category] || 0) + amount;
        categoryCount[category] = (categoryCount[category] || 0) + 1;
    });
    
    // Find top spending category
    const topCategory = Object.keys(categorySpending).reduce((a, b) => 
        categorySpending[a] > categorySpending[b] ? a : b, Object.keys(categorySpending)[0]);
    
    if (topCategory && categorySpending[topCategory] > 0) {
        const percentage = (categorySpending[topCategory] / Object.values(categorySpending).reduce((a, b) => a + b, 0)) * 100;
        
        if (percentage > 40) {
            insights.push({
                id: 'category-dominance',
                type: 'info',
                title: `${topCategory} Dominates Your Spending`,
                message: `${topCategory} accounts for ${percentage.toFixed(1)}% of your total spending ($${categorySpending[topCategory].toFixed(2)}).`,
                priority: 'medium',
                category: 'patterns',
                actionable: true,
                recommendation: `Consider creating a specific budget for ${topCategory} to better track this major expense.`
            });
        }
    }
    
    // Find frequent small purchases
    const smallTransactions = transactions.filter(t => Math.abs(parseFloat(t.amount)) < 20);
    if (smallTransactions.length > transactions.length * 0.6) {
        const totalSmall = smallTransactions.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0);
        insights.push({
            id: 'small-purchases',
            type: 'tip',
            title: 'Many Small Purchases Detected',
            message: `You made ${smallTransactions.length} small purchases (under $20) totaling $${totalSmall.toFixed(2)}.`,
            priority: 'low',
            category: 'patterns',
            actionable: true,
            recommendation: 'Consider tracking small purchases more carefully - they can add up quickly!'
        });
    }
    
    return insights;
}

// Analyze budget performance
async function analyzeBudgetPerformance(transactions, budgetTemplates) {
    const insights = [];
    
    // Simple budget analysis
    if (budgetTemplates.length > 0) {
        insights.push({
            id: 'budget-available',
            type: 'success',
            title: 'Budget Templates Available',
            message: `You have ${budgetTemplates.length} budget template(s) set up. Great job planning ahead!`,
            priority: 'low',
            category: 'budgeting',
            actionable: false
        });
    }
    
    return insights;
}

// Detect spending anomalies
async function detectSpendingAnomalies(transactions) {
    const insights = [];
    
    // Find unusually large transactions
    const amounts = transactions.map(t => Math.abs(parseFloat(t.amount) || 0));
    amounts.sort((a, b) => b - a);
    
    if (amounts.length > 0) {
        const largest = amounts[0];
        const median = amounts[Math.floor(amounts.length / 2)];
        
        if (largest > median * 5 && largest > 200) {
            const largeTransaction = transactions.find(t => Math.abs(parseFloat(t.amount)) === largest);
            insights.push({
                id: 'large-transaction',
                type: 'info',
                title: 'Unusually Large Transaction Detected',
                message: `Your largest transaction was $${largest.toFixed(2)} in ${largeTransaction?.category || 'Unknown'} category.`,
                priority: 'medium',
                category: 'anomalies',
                actionable: false
            });
        }
    }
    
    return insights;
}

// Generate future predictions
async function generatePredictions(transactions) {
    const insights = [];
    
    if (transactions.length >= 10) {
        const monthlyAvg = transactions.reduce((sum, t) => sum + Math.abs(parseFloat(t.amount)), 0) / 
                          (transactions.length / 30); // Rough monthly average
        
        insights.push({
            id: 'monthly-prediction',
            type: 'prediction',
            title: 'Monthly Spending Prediction',
            message: `Based on your patterns, you're on track to spend approximately $${monthlyAvg.toFixed(2)} this month.`,
            priority: 'medium',
            category: 'predictions',
            actionable: true,
            recommendation: 'Monitor your spending closely as you approach this predicted amount.'
        });
    }
    
    return insights;
}