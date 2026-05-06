import asyncio
import random
from websockets_manager import manager

tracked_stocks = {
    # Portolio Holdings
    "AAPL": 273.05, "ADSK": 245.31, "AMD": 274.95, "AMZN": 248.28,
    "AVGO": 399.63, "BABA": 140.17, "BROS": 54.82, "CL": 83.53,
    "COIN": 211.63, "GOOG": 335.40, "INTC": 85.70, "MSFT": 418.07,
    "NVDA": 145.70, "ORCL": 177.58, "PG": 144.49, "QCOM": 137.52,
    "SOUN": 8.32, "TSLA": 392.50, "TSM": 368.24, "TXN": 233.70, "XOM": 147.68,
    # Phase 1 Recommendations
    "LLY": 885.30, "CRWD": 312.15, "PLTR": 24.50
}

async def market_data_simulator():
    print("Initializing Market Data Simulator Stream...")
    
    while True:
        updates = []
        for symbol, price in tracked_stocks.items():
            volatility = price * 0.002
            change = random.uniform(-volatility, volatility)
            new_price = round(price + change, 2)
            
            tracked_stocks[symbol] = new_price
            
            updates.append({
                "symbol": symbol,
                "price": new_price,
                "change": round(change, 2),
                "timestamp": asyncio.get_event_loop().time()
            })
            
        await manager.broadcast({"type": "market_tick", "data": updates})
        await asyncio.sleep(1.5)
