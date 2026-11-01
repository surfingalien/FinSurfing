# Quant Lab cross-validation

Checks `lib/quant/*` against independent reference libraries. Not part of `npm test` (it needs Python packages);
run it after changing any quant maths.

```bash
pip install QuantLib statsmodels scikit-learn arch scipy numpy
node tools/quant-validation/dump.js     # deterministic inputs + our outputs -> out/dump.json
python3 tools/quant-validation/check.py # compares with the references, prints PASS/FAIL per group
```

| Area | Reference |
|---|---|
| Black–Scholes price, 5 Greeks, American binomial (CRR) and finite-difference, Heston, SABR | QuantLib |
| Normal / chi-square / beta functions, Beta–Binomial interval | scipy |
| Cholesky, eigenvalues, inverse, PCA | numpy |
| OLS, ADF, Engle–Granger, ACF / Ljung–Box, ARIMA, Markov-switching (HMM) | statsmodels |
| GARCH(1,1) | arch |
| Ledoit–Wolf, 9 classifiers, MLP, k-means / DBSCAN / hierarchical, t-SNE | scikit-learn |
| Min-variance, max-Sharpe | scipy SLSQP |
| Parkinson, Garman–Klass, Yang–Zhang, rolling, EWMA, risk parity | independent numpy formulas |

Tolerances are per check and printed with every failure. Where two methods legitimately differ (least squares vs
MLE for ARIMA/GARCH, Monte Carlo vs lattice, a 1-cent out-of-the-money option priced on a finite grid) the
tolerance is wider and says why. Maturities are whole days because QuantLib counts days.
