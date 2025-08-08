#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { SpendSmartStack } from '../lib/spendsmart-stack';

const app = new cdk.App();

const stage = app.node.tryGetContext('stage') || 'dev';

new SpendSmartStack(app, `SpendSmartStack-${stage}`, {
  stage: stage as 'dev' | 'prod',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1'
  }
});