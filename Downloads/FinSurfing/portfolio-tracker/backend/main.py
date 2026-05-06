import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from websockets_manager import manager
from services.market_data import market_data_simulator

app = FastAPI(title="Portfolio Tracker API", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], 
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from api.routes.ai import router as ai_router
app.include_router(ai_router)


@app.on_event("startup")
async def startup_event():
    asyncio.create_task(market_data_simulator())

@app.websocket("/ws/market-data")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            print(f"Received client message: {data}")
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/api/v1/health")
async def health_check():
    return {"status": "ok", "message": "Backend and WebSocket servers are running."}
