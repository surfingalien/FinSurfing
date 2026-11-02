/**
 * Quant reference — the vocabulary, strategy and model lists, each tied to where FinSurfing implements it.
 * `where` is a route id or `quant-lab/<tab>`; null means a definition only (nothing to run).
 * The status of every item here is checked by tests/quant-reference.test.js against the real route table,
 * so a link can never point at a tab that does not exist.
 */
const Q = t => `quant-lab/${t}`

// [term, definition, where]
export const TERMS = [
  ['Alpha', 'Returns beyond the benchmark', Q('risk')], ['Beta', 'Sensitivity to market moves', Q('risk')], ['Sharpe ratio', 'Return per unit of risk', 'analytics'],
  ['Drawdown', 'Peak-to-trough loss', 'analytics'], ['Backtest', 'Test a strategy on past data', 'backtest'], ['Overfitting', 'Fits noise, not signal', 'research-desk'],
  ['Look-ahead bias', 'Using future information', Q('models')], ['Survivorship bias', 'Ignoring failed assets', 'research-desk'], ['Stationarity', 'Stable statistical properties', Q('series')],
  ['Mean reversion', 'Prices revert to average', Q('strategies')], ['Momentum', 'Winners keep winning', 'research-desk'], ['Volatility', 'Dispersion of returns', Q('vol')],
  ['Autocorrelation', 'Correlation with own past', Q('series')], ['Cointegration', 'Shared long-run relationship', Q('strategies')], ['Regression', 'Model variable relationships', Q('risk')],
  ['Regularization', 'Penalize model complexity', Q('models')], ['Cross-validation', 'Test on held-out folds', 'strategies'], ['Signal', 'Predictive trading indicator', 'research-desk'],
  ['Covariance', 'How assets move together', Q('portfolio')], ['PCA', 'Reduce dimensions, keep variance', Q('risk')], ['Kalman filter', 'Estimate a hidden state', Q('strategies')],
  ['Martingale', 'Fair game, no drift', Q('series')], ['Brownian motion', 'Continuous random walk', Q('options')], ['Monte Carlo', 'Simulate with random draws', Q('options')],
  ['Bootstrap', 'Resample to estimate error', Q('risk')], ['P-value', 'Odds of result under null', 'brain-activity'], ['Bayesian inference', 'Update beliefs with data', Q('risk')],
  ['Maximum likelihood', 'Parameters that best fit data', Q('vol')], ['Bias–variance', 'Accuracy vs stability trade-off', Q('models')], ['Delta', 'Option sensitivity to spot', Q('options')],
  ['Gamma', 'Rate of change of delta', Q('options')], ['Vega', 'Sensitivity to volatility', Q('options')], ['Implied volatility', 'Market-expected volatility', Q('options')],
  ['Black–Scholes', 'Classic option pricing model', Q('options')], ['Arbitrage', 'Risk-free profit', Q('calculators')], ['Slippage', 'Gap from expected fill price', Q('risk')],
  ['Market impact', 'Price move caused by trading', Q('risk')], ['Liquidity', 'Ease of trading quickly', Q('risk')], ['Bid–ask spread', 'Cost of immediate trade', Q('calculators')],
  ['Alpha decay', 'Signal fading over time', 'research-desk'], ['Kelly criterion', 'Optimal bet sizing', 'buy-signals'], ['Value at Risk', 'Loss threshold at confidence', 'analytics'],
  ['Expected shortfall', 'Average loss beyond VaR', 'analytics'], ['Fat tails', 'Extremes likelier than normal', 'tail-ridge'], ['Efficient frontier', 'Max return per risk level', Q('portfolio')],
  ['Out-of-sample', 'Data unseen in fitting', 'research-desk'], ['Walk-forward', 'Rolling train–test validation', 'research-desk'], ['Hedging', 'Offset an exposure', Q('options')],
  ["Itô's lemma", 'Calculus for random processes', Q('calculators')], ['Information ratio', 'Active return per tracking risk', Q('risk')],
  ['Heteroskedasticity', 'Non-constant error variance', Q('vol')], ['Multicollinearity', 'Correlated predictors', Q('risk')], ['Sortino ratio', 'Return per downside risk', 'analytics'],
  ['Calmar ratio', 'Return over max drawdown', 'backtest'], ['Treynor ratio', 'Return per unit of beta', Q('risk')], ["Jensen's alpha", 'CAPM-adjusted excess return', Q('risk')],
  ['CAPM', 'Risk–return pricing model', Q('risk')], ['Fama–French', 'Multi-factor return model', 'research-desk'], ['Factor exposure', 'Loading on risk drivers', 'research-desk'],
  ['Risk premium', 'Reward for bearing risk', Q('risk')], ['GARCH', 'Models volatility clustering', Q('vol')], ['ARIMA', 'Time-series forecasting model', Q('series')],
  ['Ornstein–Uhlenbeck', 'Mean-reverting process', Q('strategies')], ['Hurst exponent', 'Trending vs reverting measure', Q('series')], ['Random walk', 'Unpredictable price path', Q('series')],
  ['Fourier transform', 'Split into frequencies', Q('series')], ['Eigenvalue', 'Variance along a component', Q('risk')], ['Cholesky', 'Sample correlated randoms', Q('risk')],
  ['Gradient descent', 'Iteratively minimize loss', Q('models')], ['Random forest', 'Ensemble of decision trees', Q('models')], ['Feature engineering', 'Craft predictive inputs', Q('models')],
  ['Data snooping', 'Over-testing the same data', 'research-desk'], ['Multiple testing', 'Inflated false discoveries', 'research-desk'], ['Information coefficient', 'Signal–return rank correlation', 'research-desk'],
  ['Turnover', 'Portfolio trading frequency', Q('portfolio')], ['Transaction costs', 'Fees eroding returns', 'backtest'], ['Market making', 'Quote both sides for spread', Q('calculators')],
  ['Order book', 'Live bids and asks', Q('calculators')], ['Latency', 'Delay in execution speed', Q('calculators')], ['VWAP', 'Volume-weighted average price', Q('calculators')],
  ['TWAP', 'Time-weighted average price', Q('calculators')], ['Short selling', 'Profit from falling prices', Q('calculators')], ['Leverage', 'Borrowed capital amplifies', Q('calculators')],
  ['Margin call', 'Demand for more collateral', Q('calculators')], ['Pairs trading', 'Long–short related assets', Q('strategies')], ['Statistical arbitrage', 'Many small mean-reverting bets', Q('strategies')],
  ['Risk parity', 'Equal risk contribution', Q('portfolio')], ['Black–Litterman', 'Blend views with equilibrium', 'buy-signals'], ['Kurtosis', 'Tail heaviness measure', 'tail-ridge'],
  ['Skewness', 'Return asymmetry', 'tail-ridge'], ['Theta', 'Option time decay', Q('options')], ['Rho', 'Sensitivity to interest rates', Q('options')],
  ['Volatility smile', 'IV varies by strike', Q('calculators')], ['Put–call parity', 'Option price relationship', Q('options')], ['Convexity', 'Curvature of price response', Q('options')],
  ['Regime switching', 'Shifting market states', Q('series')], ['Tail risk', 'Rare extreme losses', 'tail-ridge'], ['Stress testing', 'Simulate extreme scenarios', Q('risk')],
  ['Position sizing', 'Capital allocated per trade', 'buy-signals'], ['Capacity', 'Max capital a strategy handles', Q('calculators')],
]

// [name, one-liner, where]
export const STRATEGIES = [
  ['Momentum', 'Buy what has been rising', 'backtest'], ['Mean reversion', 'Fade stretched moves', 'backtest'], ['Statistical arbitrage', 'Many small relative-value bets', Q('strategies')],
  ['Pairs trading', 'Trade the spread of cointegrated names', Q('strategies')], ['Trend following', 'Ride persistent moves', 'backtest'], ['Market making', 'Earn the spread, manage inventory', Q('calculators')],
  ['Event-driven', 'Trade earnings drift and insider buying', 'research-desk'], ['Factor investing', 'Tilt toward rewarded factors', 'research-desk'], ['Carry trade', 'Earn the rate differential', Q('calculators')],
  ['Volatility arbitrage', 'Implied vs realised vol', Q('options')], ['Options strategies', 'Price and hedge with the Greeks', Q('options')], ['Order-flow signals', 'Read unusual options activity', 'market-focus'],
  ['Cross-sectional alpha', 'Rank stocks against each other', 'research-desk'], ['Intraday reversal', 'Fade one-day drops (daily-bar proxy)', Q('strategies')], ['Breakout trading', 'Enter on range expansion', 'backtest'],
  ['Risk parity', 'Equalise risk contributions', Q('portfolio')], ['Portfolio optimisation', 'Mean–variance, min-variance, HRP', Q('portfolio')], ['Regime switching', 'Change stance with the market state', Q('series')],
  ['Machine-learning alpha', 'Models judged out of sample', Q('models')], ['Execution algorithms', 'VWAP / TWAP slicing', Q('calculators')],
  ['Merger arbitrage', 'Capture the announced-deal spread', Q('calculators')], ['Convertible arbitrage', 'Long the convert, hedge the equity', Q('calculators')], ['Capital-structure arbitrage', 'Debt vs equity mispricing (Merton)', Q('calculators')],
  ['Yield-curve arbitrage', 'Relative value across maturities', Q('calculators')], ['Basis trade', 'Cash vs futures convergence', Q('calculators')], ['Roll yield', 'Futures term-structure carry', Q('calculators')],
  ['Vol term-structure trading', 'Implied vol across expiries', Q('calculators')], ['Dispersion trading', 'Index vol vs single-stock vol', Q('calculators')], ['Gamma scalping', 'Delta-hedge long options for profit', Q('options')], ['Volatility skew trading', 'Trade the smile across strikes', Q('calculators')],
]

export const MODELS = [
  ['Black–Scholes', Q('options')], ['Monte Carlo simulation', Q('options')], ['Binomial tree', Q('options')], ['Value at Risk', 'analytics'], ['GARCH volatility', Q('vol')],
  ['CAPM', Q('risk')], ['Factor models', 'research-desk'], ['Kalman filter', Q('strategies')], ['Hidden Markov model', Q('series')], ['Heston stochastic volatility', Q('options')],
  ['Vasicek rate model', Q('calculators')], ['SABR volatility model', Q('options')], ['Copula models', Q('risk')], ['ARIMA forecasting', Q('series')], ['Principal components (PCA)', Q('risk')],
  ['Portfolio optimisation', Q('portfolio')], ['Option Greeks', Q('options')], ['Merton credit-risk model', Q('calculators')], ['ML alpha models', Q('models')], ['Risk parity model', Q('portfolio')],
]

export const ML_ALGOS = [
  ['Linear regression', Q('risk')], ['Logistic regression', Q('models')], ['k-nearest neighbours', Q('models')], ['Naive Bayes', Q('models')], ['Decision tree', Q('models')],
  ['Random forest', Q('models')], ['Gradient boosting', Q('models')], ['Support vector machine', Q('models')], ['k-means clustering', Q('models')], ['Hierarchical clustering', Q('models')],
  ['DBSCAN', Q('models')], ['PCA', Q('risk')], ['t-SNE', Q('models')], ['Linear discriminant analysis', Q('models')], ['Quadratic discriminant analysis', Q('models')],
  ['KNN regression', Q('models')], ['Neural network (MLP)', Q('models')], ['Convolutional network', Q('models')], ['Recurrent network (LSTM)', Q('models')], ['Reinforcement learning (Q-learning)', Q('models')],
]

// The Gamma Scalping playbook, item by item
export const PLAYBOOK = [
  ['Theta–gamma identity', 'θ = −½ΓS²σ²: theta is the rent for gamma; rule of 16', Q('calculators')], ['Daily scalp P&L', '½ΓS²[(ΔS/S)² − σ²Δt]: did the move beat implied?', Q('options')],
  ['Path dependence', 'Dollar gamma weights realised vol — moves near the strike pay most', Q('options')], ['Which vol to hedge', 'Hedge at realised to lock V(σr) − V(σi); at implied for a smooth path', Q('options')],
  ['Discrete hedging', 'Hedging noise ∝ 1/√N (Derman–Kamal)', Q('options')], ['No-trade band', 'With costs, hedge at the edges of a band (Whalley–Wilmott)', Q('options')],
  ['Variance risk premium', 'Implied above realised on average; the edge is forecasting realised', Q('vol')], ['Skew-aware delta', 'Δ_BS + vega·∂σ/∂S: the smile moves with spot', Q('calculators')],
]

// [method, time, memory, accuracy, best for]
export const BIG_O = [
  ['Black–Scholes', 'O(1)', 'O(1)', 'Exact in-model', 'Vanilla European'], ['Monte Carlo', 'O(N·T)', 'O(1) if streamed', 'O(1/√N) + bias', 'Exotics, high-dim'],
  ['Binomial tree', 'O(n²)', 'O(n)', 'O(1/n)', 'American options'], ['Finite difference', 'O(M·N)', 'O(M)', 'O(Δx²+Δt²) (CN)', 'Barriers, PDEs'],
  ['OLS regression', 'O(np²+p³)', 'O(p²)', 'Unbiased (BLUE)', 'Factor models'], ['PCA / SVD', 'O(np²+p³)', 'O(p²)', 'Rank-k truncation', 'Risk factors'],
  ['Cholesky', 'O(p³)', 'O(p²)', 'Exact', 'Correlated simulation'], ['Kalman filter', 'O(T·d³)', 'O(d²)', 'Optimal if linear', 'Tracking hedge ratios'],
]

/** Every `where` that is a Quant Lab tab. */
export const QUANT_TABS = ['options', 'portfolio', 'vol', 'series', 'strategies', 'risk', 'models', 'calculators', 'discovery', 'learn']
