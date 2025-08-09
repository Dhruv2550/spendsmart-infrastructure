// lib/spendsmart-stack.ts
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

interface SpendSmartStackProps extends cdk.StackProps {
  stage: 'dev' | 'prod';
}

export class SpendSmartStack extends cdk.Stack {
  public readonly api: apigateway.RestApi;
  public readonly table: dynamodb.Table;
  public readonly websiteBucket: s3.Bucket;
  public readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: SpendSmartStackProps) {
    super(scope, id, props);

    const { stage } = props;

    // DynamoDB Table
    this.table = new dynamodb.Table(this, 'SpendSmartTable', {
      tableName: `SpendSmart-Data-${stage}`,
      partitionKey: {
        name: 'PK',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'SK',
        type: dynamodb.AttributeType.STRING
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: stage === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    });

    // Add Global Secondary Index
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: {
        name: 'GSI1PK',
        type: dynamodb.AttributeType.STRING
      },
      sortKey: {
        name: 'GSI1SK',
        type: dynamodb.AttributeType.STRING
      }
    });

    // Common Lambda configuration
    const lambdaDefaults = {
      runtime: lambda.Runtime.NODEJS_18_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        DYNAMODB_TABLE_NAME: this.table.tableName,
        NODE_ENV: stage
      },
      logRetention: logs.RetentionDays.ONE_WEEK
    };

    // Lambda Functions
    const transactionsLambda = new lambda.Function(this, 'TransactionsFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-transactions-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'transactions.handler',
      description: 'Handles transaction operations'
    });

    const budgetTemplatesLambda = new lambda.Function(this, 'BudgetTemplatesFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-budget-templates-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'budget-templates.handler',
      description: 'Handles budget template operations'
    });

    const budgetsLambda = new lambda.Function(this, 'BudgetsFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-budgets-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'budgets.handler',
      description: 'Handles budgets and budget analysis operations'
    });

    const recurringTransactionsLambda = new lambda.Function(this, 'RecurringTransactionsFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-recurring-transactions-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'recurring-transactions.handler',
      description: 'Handles recurring transaction operations'
    });

    // Spending Alerts Lambda Function
    const spendingAlertsLambda = new lambda.Function(this, 'SpendingAlertsFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-spending-alerts-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'spending-alerts.handler',
      description: 'Handles spending alerts operations'
    });

    // Analytics Lambda Function
    const analyticsLambda = new lambda.Function(this, 'AnalyticsFunction', {
      ...lambdaDefaults,
      functionName: `spendsmart-analytics-${stage}`,
      code: lambda.Code.fromAsset('lambda'),
      handler: 'analytics.handler',
      description: 'Handles analytics and AI-powered insights operations'
    });

    // Grant DynamoDB permissions
    this.table.grantReadWriteData(transactionsLambda);
    this.table.grantReadWriteData(budgetTemplatesLambda);
    this.table.grantReadWriteData(budgetsLambda);
    this.table.grantReadWriteData(recurringTransactionsLambda);
    this.table.grantReadWriteData(spendingAlertsLambda);
    this.table.grantReadWriteData(analyticsLambda);

    // API Gateway
    this.api = new apigateway.RestApi(this, 'SpendSmartAPI', {
      restApiName: `SpendSmart-API-${stage}`,
      description: 'SpendSmart Budget App API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type']
      },
      deployOptions: {
        stageName: stage
      }
    });

    // API Resources
    const api = this.api.root.addResource('api');
    
    // Records endpoint (existing)
    const records = api.addResource('records');
    const transactionsIntegration = new apigateway.LambdaIntegration(transactionsLambda);
    records.addMethod('GET', transactionsIntegration);
    records.addMethod('POST', transactionsIntegration);

    // Add records by ID resource for DELETE operations
    const recordById = records.addResource('{id}');
    recordById.addMethod('DELETE', transactionsIntegration);

    // Budget Templates endpoints (new)
    const budgetTemplates = api.addResource('budget-templates');
    const budgetTemplatesIntegration = new apigateway.LambdaIntegration(budgetTemplatesLambda);
    
    // GET /api/budget-templates - get all templates
    // POST /api/budget-templates - create new template
    budgetTemplates.addMethod('GET', budgetTemplatesIntegration);
    budgetTemplates.addMethod('POST', budgetTemplatesIntegration);

    // Template-specific operations
    const templateName = budgetTemplates.addResource('{templateName}');
    
    // DELETE /api/budget-templates/{templateName} - delete template
    templateName.addMethod('DELETE', budgetTemplatesIntegration);
    
    // POST /api/budget-templates/{templateName}/copy - copy template
    const copyAction = templateName.addResource('copy');
    copyAction.addMethod('POST', budgetTemplatesIntegration);

    // Budgets endpoints
    const budgets = api.addResource('budgets');
    const budgetsIntegration = new apigateway.LambdaIntegration(budgetsLambda);
    
    // GET /api/budgets/{template}/{month} - get envelope budgets
    const budgetTemplate = budgets.addResource('{template}');
    const budgetMonth = budgetTemplate.addResource('{month}');
    budgetMonth.addMethod('GET', budgetsIntegration);

    // Budget Analysis endpoints
    const budgetAnalysis = api.addResource('budget-analysis');
    const budgetAnalysisIntegration = new apigateway.LambdaIntegration(budgetsLambda);
    
    // GET /api/budget-analysis/{template}/{month} - get spending analysis
    const analysisTemplate = budgetAnalysis.addResource('{template}');
    const analysisMonth = analysisTemplate.addResource('{month}');
    analysisMonth.addMethod('GET', budgetAnalysisIntegration);

    // Recurring Transactions endpoints
    const recurring = api.addResource('recurring');
    const recurringIntegration = new apigateway.LambdaIntegration(recurringTransactionsLambda);

    // GET /api/recurring - get all recurring transactions
    // POST /api/recurring - create new recurring transaction
    recurring.addMethod('GET', recurringIntegration);
    recurring.addMethod('POST', recurringIntegration);

    // Recurring transaction by ID
    const recurringById = recurring.addResource('{id}');

    // GET /api/recurring/{id} - get specific recurring transaction
    // PUT /api/recurring/{id} - update recurring transaction
    // DELETE /api/recurring/{id} - delete recurring transaction
    recurringById.addMethod('GET', recurringIntegration);
    recurringById.addMethod('PUT', recurringIntegration);
    recurringById.addMethod('DELETE', recurringIntegration);

    // PUT /api/recurring/{id}/toggle - toggle active/inactive
    const toggleAction = recurringById.addResource('toggle');
    toggleAction.addMethod('PUT', recurringIntegration);

    // POST /api/recurring/{id}/execute - execute specific transaction
    const executeAction = recurringById.addResource('execute');
    executeAction.addMethod('POST', recurringIntegration);

    // POST /api/recurring/execute-due - execute all due transactions
    const executeDue = recurring.addResource('execute-due');
    executeDue.addMethod('POST', recurringIntegration);

    // GET /api/recurring/upcoming - get upcoming transactions
    const upcoming = recurring.addResource('upcoming');
    upcoming.addMethod('GET', recurringIntegration);

    // Spending Alerts endpoints
    const alerts = api.addResource('alerts');
    const spendingAlertsIntegration = new apigateway.LambdaIntegration(spendingAlertsLambda);
    
    // GET /api/alerts - get all spending alerts
    // POST /api/alerts - create new spending alert
    alerts.addMethod('GET', spendingAlertsIntegration);
    alerts.addMethod('POST', spendingAlertsIntegration);

    // Individual alert resource - /api/alerts/{id}
    const alertById = alerts.addResource('{id}');
    
    // GET /api/alerts/{id} - get specific spending alert
    alertById.addMethod('GET', spendingAlertsIntegration);
    // PUT /api/alerts/{id} - update spending alert
    // DELETE /api/alerts/{id} - delete spending alert
    alertById.addMethod('PUT', spendingAlertsIntegration);
    alertById.addMethod('DELETE', spendingAlertsIntegration);

    // Analytics endpoints
    const analytics = api.addResource('analytics');
    const analyticsIntegration = new apigateway.LambdaIntegration(analyticsLambda);
    
    // Insights endpoint
    const insights = analytics.addResource('insights');
    
    // GET /api/analytics/insights - get AI-powered spending insights
    insights.addMethod('GET', analyticsIntegration);

    // Health check (existing)
    const health = api.addResource('health');
    health.addMethod('GET', new apigateway.MockIntegration({
      integrationResponses: [{
        statusCode: '200',
        responseTemplates: {
          'application/json': JSON.stringify({
            status: 'OK',
            timestamp: '$context.requestTime'
          })
        }
      }],
      requestTemplates: {
        'application/json': '{ "statusCode": 200 }'
      }
    }), {
      methodResponses: [{ statusCode: '200' }]
    });

    // S3 Bucket for Frontend
    this.websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL
    });
    

    // CloudFront Distribution
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.websiteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.RestApiOrigin(this.api),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED
        }
      },
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html'
        }
      ]
    });

    // Outputs
    new cdk.CfnOutput(this, 'APIEndpoint', {
      value: this.api.url,
      description: 'API Gateway endpoint URL'
    });
    
    
    new cdk.CfnOutput(this, 'WebsiteURL', {
      value: `https://${this.distribution.distributionDomainName}`,
      description: 'Website URL'
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: this.websiteBucket.bucketName,
      description: 'S3 bucket name for frontend'
    });
  }
}