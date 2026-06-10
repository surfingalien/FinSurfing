'use strict'
/**
 * lib/crypto-classify.js
 *
 * Pure crypto symbol classification + exchange-format mapping, extracted
 * verbatim from server.js so it can be unit-tested and eventually shared
 * (routes/trading-analysis.js still carries a mirror of isCryptoSymbol).
 */

const KNOWN_CRYPTO = new Set([
  'BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','MATIC','LINK',
  'UNI','LTC','BCH','TRX','NEAR','SHIB','APT','ARB','OP','SUI','SEI','INJ',
  'TIA','JUP','WIF','BONK','PEPE','TON','ATOM','FIL','ICP','XLM','XMR','DASH',
  'ZEC','ETC','GRT','CAKE','FTM','ONE','WAVES','DYDX','BLUR','ORDI','SATS',
  'HBAR','FLOW','EOS','XTZ','THETA','ALGO','VET','MANA','SAND','AXS','CRV',
  'AAVE','MKR','COMP','SNX','YFI','SUSHI','BAT','ZETA','PYTH','JTO','MEME',
  'OP','ARB','LDO','RPL','STX','CFX','OCEAN','IMX','GALA','GMT','STEPN',
  'APE','LUNC','LUNA','USTC','FTT','HNT','RAY','SRM','MNGO','STEP',
])

function isCryptoSymbol(symbol) {
  if (!symbol) return false
  const s = symbol.toUpperCase()
  // Yahoo Finance format: BTC-USD, ETH-USD, SOL-USD (dash + 3-4 letter currency)
  if (/^[A-Z0-9.]+-[A-Z]{3,4}$/.test(s)) return true
  // Bare ticker known to be crypto (e.g. SOL, BTC from COINBASE:SOL)
  if (KNOWN_CRYPTO.has(s)) return true
  return false
}

function toBinancePair(symbol) {
  const s = symbol.toUpperCase()
  // Yahoo dash format: BTC-USD → BTCUSDT, ETH-BTC → ETHBTC
  if (s.includes('-')) {
    const base = s.replace(/-(USD|USDT|USDC|BUSD|BTC|ETH|EUR|GBP|BNB)$/, '')
    const quote = s.includes('-BTC') ? 'BTC' : s.includes('-ETH') ? 'ETH' : 'USDT'
    return base + quote
  }
  // Composite without dash: SOLUSDT stays, SOLUSD → SOLUSDT
  if (s.endsWith('USD') && !s.endsWith('USDT')) return s.slice(0, -3) + 'USDT'
  if (s.endsWith('USDT') || s.endsWith('BTC') || s.endsWith('ETH')) return s
  // Bare ticker: SOL → SOLUSDT
  return s + 'USDT'
}

const COINGECKO_IDS = {
  'BTC':'bitcoin','ETH':'ethereum','SOL':'solana','BNB':'binancecoin',
  'XRP':'ripple','ADA':'cardano','DOGE':'dogecoin','AVAX':'avalanche-2',
  'DOT':'polkadot','MATIC':'matic-network','LINK':'chainlink','UNI':'uniswap',
  'LTC':'litecoin','BCH':'bitcoin-cash','ATOM':'cosmos','NEAR':'near',
  'FIL':'filecoin','TRX':'tron','XLM':'stellar','SHIB':'shiba-inu',
  'APT':'aptos','ARB':'arbitrum','OP':'optimism','SUI':'sui','INJ':'injective-protocol',
  'TON':'the-open-network','PEPE':'pepe','WIF':'dogwifcoin','JUP':'jupiter-exchange-solana',
  'ICP':'internet-computer','HBAR':'hedera-hashgraph','AAVE':'aave','SAND':'the-sandbox',
  'MANA':'decentraland','GRT':'the-graph','CRV':'curve-dao-token','DYDX':'dydx',
  'LDO':'lido-dao','STX':'blockstack','THETA':'theta-token','FTM':'fantom',
  'ALGO':'algorand','VET':'vechain','EOS':'eos','ZEC':'zcash','XMR':'monero',
}

function cgId(symbol) {
  const base = symbol.toUpperCase().replace(/-(USD|USDT|USDC|BTC|ETH|EUR|GBP)$/, '')
  return COINGECKO_IDS[base] || null
}

module.exports = { KNOWN_CRYPTO, isCryptoSymbol, toBinancePair, COINGECKO_IDS, cgId }
