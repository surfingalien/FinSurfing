'use strict'
/**
 * utils/bedrockClient.js
 *
 * Shared lazy AWS Bedrock Runtime client.
 * Reads credentials from env vars (Railway vars):
 *   AWS_ACCESS_KEY_ID
 *   AWS_SECRET_ACCESS_KEY
 *   AWS_REGION  (default: us-east-1)
 *
 * On EC2/ECS/Lambda the SDK auto-discovers IAM-role credentials — no key needed.
 */

let _client = null

function getBedrockClient() {
  if (_client) return _client

  const region = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'

  // Explicit credentials check (skip when running on AWS with IAM roles)
  const hasExplicitCreds = !!(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY)
  const hasImplicitCreds = !!(
    process.env.AWS_ROLE_ARN ||
    process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
    process.env.AWS_WEB_IDENTITY_TOKEN_FILE
  )

  if (!hasExplicitCreds && !hasImplicitCreds) {
    throw new Error(
      'AWS credentials not configured. ' +
      'Set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in Railway environment variables.'
    )
  }

  const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime')
  _client = new BedrockRuntimeClient({ region })
  return _client
}

module.exports = { getBedrockClient }
