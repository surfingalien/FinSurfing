import uuid
from datetime import datetime
from sqlalchemy import Column, String, Float, ForeignKey, DateTime, JSON
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()

class User(Base):
    __tablename__ = "users"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, index=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    
    portfolios = relationship("Portfolio", back_populates="owner", cascade="all, delete-orphan")

class Portfolio(Base):
    """A user can have multiple portfolios (e.g. Robinhood, 401k)."""
    __tablename__ = "portfolios"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    name = Column(String(100), nullable=False)
    target_allocations = Column(JSON, nullable=True) # e.g. {"AAPL": 0.15, "NVDA": 0.10}
    
    owner = relationship("User", back_populates="portfolios")
    holdings = relationship("Holding", back_populates="portfolio", cascade="all, delete-orphan")

class Holding(Base):
    """The aggregate summary of a specific stock ticker."""
    __tablename__ = "holdings"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    portfolio_id = Column(UUID(as_uuid=True), ForeignKey("portfolios.id"), nullable=False)
    symbol = Column(String(10), nullable=False, index=True)
    total_quantity = Column(Float, default=0.0)
    average_cost = Column(Float, default=0.0)
    
    portfolio = relationship("Portfolio", back_populates="holdings")
    transactions = relationship("TransactionLot", back_populates="holding")

class TransactionLot(Base):
    """Individual buy/sell orders. Critical for tax calculations."""
    __tablename__ = "transaction_lots"
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    holding_id = Column(UUID(as_uuid=True), ForeignKey("holdings.id"), nullable=False)
    type = Column(String(10), nullable=False) # 'BUY' or 'SELL'
    quantity = Column(Float, nullable=False)
    price_per_share = Column(Float, nullable=False)
    fees = Column(Float, default=0.0)
    execution_date = Column(DateTime, default=datetime.utcnow)
    
    holding = relationship("Holding", back_populates="transactions")
