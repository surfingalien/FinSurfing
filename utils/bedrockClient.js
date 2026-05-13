'use strict'
/**
 * utils/bedrockClient.js
 *
 * Shared lazy AWS Bedrock Runtime client.
 *
 * Railway env vars (add all three in your service variables):
 *   AWS_ACCESS_KEY_ID       — required
 *   AWS_SECRET_ACCESS_KEY   — required
 *   AWS_SESSION_TOKEN       — required ONLY for temporary/STS credentials
 *                             (keys starting with "ASIA..." are always temporary)
 *   AWS_REGION              — defaults to us-east-1
 *
 * Credentials are passed explicitly so the SDK never silently falls back to
 * a stale credential chain that might omit the session token.
 */

let _client = null

function getBedrockClient() {
  if (_client) return _client

  const region    = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
  const accessKey = process.env.AWS_ACCESS_KEY_ID
  const secretKey = process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = process.env.AWS_SESSION_TOKEN  // undefined when using permanent IAM user keys

  // ── Credential validation ──────────────────────────────────────────────────
  if (!accessKey || !secretKey) {
    throw new Error(
      'AWS credentials not configured. ' +
      'Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in Railway environment variables.'
    )
  }

  // Keys that start with "ASIA" are STS temporary credentials — they always need a session token
  if (accessKey.startsWith('ASIA') && !sessionToken) {
    throw new Error(
      'AWS_SESSION_TOKEN is required for temporary credentials (keys starting with ASIA). ' +
      'Add AWS_SESSION_TOKEN to your Railway environment variables, ' +
      'or create a permanent IAM user key (starts with AKIA) instead.'
    )
  }

  const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime')

  const credentials = {
    accessKeyId:     accessKey,
    secretAccessKey: secretKey,
    ...(sessionToken ? { sessionToken } : {}),
  }

  _client = new BedrockRuntimeClient({ region, credentials })
  return _client
}

// Allow resetting the cached client (e.g. after credential rotation)
function resetBedrockClient() { _client = null }

module.exports = { getBedrockClient, resetBedrockClient }
