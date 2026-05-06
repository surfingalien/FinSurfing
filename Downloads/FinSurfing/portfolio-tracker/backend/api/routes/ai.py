from fastapi import APIRouter
from ml.sentiment import fetch_reddit_sentiment
from ml.predictor import train_prediction_model

router = APIRouter(prefix="/api/v1/ai", tags=["Artificial Intelligence"])

@router.get("/sentiment/{ticker}")
async def get_sentiment(ticker: str):
    """Returns the live FinBERT NLP sentiment score for a stock."""
    return fetch_reddit_sentiment(ticker)

@router.get("/predict/{ticker}")
async def get_prediction(ticker: str, days: int = 30):
    """Returns the LSTM projected bounds for the asset."""
    # (In production, this result is cached in Redis so we don't retrain on every request)
    return train_prediction_model(ticker, days)
