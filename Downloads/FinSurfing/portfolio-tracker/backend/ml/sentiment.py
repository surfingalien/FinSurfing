import requests

# We use FinBERT - a pre-trained NLP model fine-tuned entirely on financial texts
# For the actual deployment, 'transformers' pipeline is used. We use a mock API wrapper here for demonstration.

def fetch_reddit_sentiment(ticker: str) -> dict:
    """
    Scrapes the top posts from r/stocks mentioning the ticker, 
    and simulates scoring the aggregate sentiment using an NLP model.
    """
    print(f"Scraping Reddit sentiment for {ticker}...")
    
    # In a full deployment, you uncomment this NLP pipeline:
    # from transformers import pipeline
    # nlp_analyzer = pipeline("sentiment-analysis", model="ProsusAI/finbert")
    
    try:
        # Simulate an API grab to Reddit
        url = f"https://www.reddit.com/r/stocks/search.json?q={ticker}&t=day&restrict_sr=1"
        headers = {"User-Agent": "Mozilla/5.0"}
        
        response = requests.get(url, headers=headers)
        if response.status_code == 200:
            posts = response.json().get('data', {}).get('children', [])
            volume = len(posts)
        else:
            volume = 12 # fallback mock

        # Mocking FinBERT's heatscore based on ticker 
        # (Usually this processes the actual 'posts' array through the tensor arrays)
        bullish_bias = {"NVDA": 0.5, "MSFT": 0.4, "TSLA": -0.1, "AAPL": 0.1, "CRWD": 0.42, "LLY": 0.3}
        heat_score = bullish_bias.get(ticker, 0.05) 
        
        status = "BULLISH" if heat_score > 0.2 else "BEARISH" if heat_score < -0.2 else "NEUTRAL"
        
        return {
            "sentiment": status,
            "score": round(heat_score, 2), # Between -1.0 and 1.0
            "chatter_volume": volume
        }
        
    except Exception as e:
        print(f"Error fetching sentiment: {e}")
        return {"sentiment": "ERROR", "score": 0.0, "volume": 0}
