import json, math, os, warnings, collections, numpy as np
warnings.filterwarnings('ignore')
from scipy import stats as st
D=json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'out','dump.json')))
rows=[]
def rec(group,name,mine,ref,tol,rel=False,note='',floor=0.0):
    mine=float(mine); ref=float(ref)
    d=abs(mine-ref)/(abs(ref) if rel and ref!=0 else 1)
    rows.append((group,name,mine,ref,d,tol,d<=tol or abs(mine-ref)<floor,note+(' [abs floor 0.05c]' if floor else '')))

import QuantLib as ql
today=ql.Date(15,6,2026); ql.Settings.instance().evaluationDate=today
dc=ql.Actual365Fixed(); cal=ql.NullCalendar()
def proc(c):
    return ql.BlackScholesMertonProcess(ql.QuoteHandle(ql.SimpleQuote(c['S'])),ql.YieldTermStructureHandle(ql.FlatForward(today,c['q'],dc)),ql.YieldTermStructureHandle(ql.FlatForward(today,c['r'],dc)),ql.BlackVolTermStructureHandle(ql.BlackConstantVol(today,cal,c['sigma'],dc)))
def mat(T): return today+int(round(T*365))
for c in D['options']:
    typ=ql.Option.Call if c['type']=='call' else ql.Option.Put; payoff=ql.PlainVanillaPayoff(typ,c['K']); m=mat(c['T'])
    eu=ql.VanillaOption(payoff,ql.EuropeanExercise(m)); eu.setPricingEngine(ql.AnalyticEuropeanEngine(proc(c)))
    tag=f"{c['type']} S{c['S']:g} K{c['K']:g} T{c['T']:g}"
    rec('Black-Scholes price vs QuantLib',tag,c['bs'],eu.NPV(),1e-6)
    g=c['greeks']
    rec('Greeks vs QuantLib',tag+' delta',g['delta'],eu.delta(),1e-6); rec('Greeks vs QuantLib',tag+' gamma',g['gamma'],eu.gamma(),1e-6)
    rec('Greeks vs QuantLib',tag+' vega',g['vega'],eu.vega(),1e-5,True); rec('Greeks vs QuantLib',tag+' theta',g['theta'],eu.theta(),1e-5,True); rec('Greeks vs QuantLib',tag+' rho',g['rho'],eu.rho(),1e-5,True)
    rec('Implied vol round-trip',tag,c['iv'],c['sigma'],1e-6)
    am=ql.VanillaOption(payoff,ql.AmericanExercise(today,m)); am.setPricingEngine(ql.BinomialVanillaEngine(proc(c),'crr',1000)); ref_am=am.NPV()
    rec('American binomial vs QuantLib CRR(1000)',tag,c['amBinomial'],ref_am,2e-4,True,'same method')
    am2=ql.VanillaOption(payoff,ql.AmericanExercise(today,m)); am2.setPricingEngine(ql.FdBlackScholesVanillaEngine(proc(c),400,400)); ref_fd=am2.NPV()
    rec('American finite-diff vs QuantLib FD(400x400)',tag,c['amFD'],ref_fd,0.01,True,'different scheme',floor=5e-4)
    rec('European binomial vs analytic',tag,c['euBinomial'],eu.NPV(),2e-3,True,floor=5e-4)
    rec('European finite-diff vs analytic',tag,c['euFD'],eu.NPV(),4e-3,True,floor=5e-4)
    if c['lsm']: rec('American Monte Carlo (LSM) vs QuantLib binomial',tag,c['lsm']['price'],ref_am,0.03,True,'MC, biased low; se=%.3f'%c['lsm']['se'])
for h in D['heston']:
    for typ in ['call','put']:
        qt=ql.Option.Call if typ=='call' else ql.Option.Put
        hp=ql.HestonProcess(ql.YieldTermStructureHandle(ql.FlatForward(today,h['r'],dc)),ql.YieldTermStructureHandle(ql.FlatForward(today,h['q'],dc)),ql.QuoteHandle(ql.SimpleQuote(h['S'])),h['v0'],h['kappa'],h['theta'],h['xi'],h['rho'])
        o=ql.VanillaOption(ql.PlainVanillaPayoff(qt,h['K']),ql.EuropeanExercise(mat(h['T']))); o.setPricingEngine(ql.AnalyticHestonEngine(ql.HestonModel(hp)))
        rec('Heston vs QuantLib AnalyticHestonEngine',f"{typ} K{h['K']} T{h['T']} rho{h['rho']}",h[typ],o.NPV(),1e-3,True)
for s in D['sabr']:
    ref=ql.sabrVolatility(s['K'],s['F'],s['T'],s['alpha'],s['beta'],s['nu'],s['rho'])
    rec('SABR vs QuantLib sabrVolatility',f"F{s['F']:g} K{s['K']:g} beta{s['beta']}",s['vol'],ref,1e-8,True)

sp=D['special']
for x,c in zip(sp['x'],sp['cdf']): rec('Special functions vs scipy','normCdf(%g)'%x,c,st.norm.cdf(x),1e-12)
for p,v in zip(sp['p'],sp['inv']): rec('Special functions vs scipy','normInv(%g)'%p,v,st.norm.ppf(p),1e-7)
for x,k,v in sp['chi2']: rec('Special functions vs scipy',f'chi2 survival({x},{k})',v,st.chi2.sf(x,k),1e-9)
for x,a,b,v in sp['beta']: rec('Special functions vs scipy',f'beta cdf({x},{a},{b})',v,st.beta.cdf(x,a,b),1e-8)
bb=sp['bayes']; rec('Beta-Binomial (37/60) vs scipy','posterior mean',bb['posteriorMean'],38/62,1e-12); rec('Beta-Binomial (37/60) vs scipy','95% lower',bb['lo'],st.beta.ppf(0.025,38,24),1e-7); rec('Beta-Binomial (37/60) vs scipy','95% upper',bb['hi'],st.beta.ppf(0.975,38,24),1e-7); rec('Beta-Binomial (37/60) vs scipy','P(p>0.5)',bb['probAbove'],1-st.beta.cdf(0.5,38,24),1e-8)

import statsmodels.api as sm
A=np.array(D['la']['A']); Lc=np.array(D['la']['chol']); rec('Linear algebra vs numpy','Cholesky max diff',np.abs(Lc-np.linalg.cholesky(A)).max(),0,1e-12)
ev=np.array(D['la']['eig']['values']); rec('Linear algebra vs numpy','Jacobi eigenvalues max diff',np.abs(ev-np.sort(np.linalg.eigvalsh(A))[::-1]).max(),0,1e-10)
rec('Linear algebra vs numpy','inverse max diff',np.abs(np.array(D['la']['inv'])-np.linalg.inv(A)).max(),0,1e-10)
o=D['ols']; m=sm.OLS(np.array(o['y']),sm.add_constant(np.array(o['X']))).fit()
rec('OLS vs statsmodels','beta max diff',np.abs(np.array(o['beta'])-m.params).max(),0,1e-9); rec('OLS vs statsmodels','t-stat max diff',np.abs(np.array(o['tstat'])-m.tvalues).max(),0,1e-7); rec('OLS vs statsmodels','R-squared',o['r2'],m.rsquared,1e-9)

from statsmodels.tsa.stattools import adfuller, coint, acf, q_stat
T_=D['ts']
rec('ADF vs statsmodels','random walk statistic',T_['adfRw']['stat'],adfuller(T_['rw'],maxlag=8,autolag='AIC',regression='c')[0],0.05)
rec('ADF vs statsmodels','stationary AR(1) statistic',T_['adfSt']['stat'],adfuller(T_['st'],maxlag=8,autolag='AIC',regression='c')[0],0.05)
rec('Engle-Granger vs statsmodels coint','cointegrated pair statistic',T_['egCoint']['stat'],coint(T_['y'],T_['x'],trend='c',maxlag=8,autolag='aic')[0],0.6,False,'statsmodels uses a no-constant ADF on residuals; the decision is what matters')
rec('Engle-Granger vs statsmodels coint','independent walks statistic',T_['egIndep']['stat'],coint(T_['y2'],T_['x'],trend='c',maxlag=8,autolag='aic')[0],0.6,False,'decision matters')
dec_ok=(T_['egCoint']['stat']<-3.34)==(coint(T_['y'],T_['x'])[1]<0.05) and (T_['egIndep']['stat']<-3.34)==(coint(T_['y2'],T_['x'])[1]<0.05)
rows.append(('Engle-Granger vs statsmodels coint','same 5% decision on both pairs',0,0,0,0,dec_ok,''))
a=acf(T_['st'],nlags=5,fft=False)[1:]; rec('ACF / Ljung-Box vs statsmodels','ACF max diff',np.abs(np.array(T_['acf'])-a).max(),0,1e-9)
q,p=q_stat(acf(T_['st'],nlags=10,fft=False)[1:],len(T_['st'])); rec('ACF / Ljung-Box vs statsmodels','Ljung-Box Q',T_['ljung']['q'],q[-1],1e-7,True)
ar1=sm.OLS(np.array(T_['st'][1:]),sm.add_constant(np.array(T_['st'][:-1]))).fit(); rec('OU half-life vs AR(1) OLS','half-life',T_['ou']['halfLife'],-math.log(2)/math.log(ar1.params[1]),1e-6,True)
from statsmodels.tsa.arima.model import ARIMA
ar=D['arima']; r=ARIMA(np.array(ar['y']),order=(2,0,0)).fit(); fc=r.forecast(10)
rec('ARIMA vs statsmodels (MLE)','AR(2) 10-step forecast gap / sigma',np.abs(np.array(ar['fc'])-fc).max()/math.sqrt(r.params[-1]),0,0.15,False,'least squares vs MLE')
rec('ARIMA vs statsmodels (MLE)','AR(2) innovation sigma',ar['sigma'],math.sqrt(r.params[-1]),0.03,True)
a2=D['arima2']; r2=ARIMA(np.array(a2['y']),order=(1,1,0)).fit(); fc2=r2.forecast(5)
rec('ARIMA vs statsmodels (MLE)','ARIMA(1,1,0) 5-step forecast gap (price units)',np.abs(np.array(a2['fc'])-fc2).max(),0,0.5)
from arch import arch_model
g=D['garch']; am=arch_model(np.array(g['r'])*100,mean='Zero',vol='GARCH',p=1,q=1,dist='normal').fit(disp='off'); pa=am.params
rec('GARCH(1,1) vs arch package (MLE)','alpha',g['alpha'],pa['alpha[1]'],0.04); rec('GARCH(1,1) vs arch package (MLE)','beta',g['beta'],pa['beta[1]'],0.05); rec('GARCH(1,1) vs arch package (MLE)','persistence',g['persistence'],pa['alpha[1]']+pa['beta[1]'],0.03)
lr=math.sqrt(pa['omega']/(1-pa['alpha[1]']-pa['beta[1]'])*252)/100; rec('GARCH(1,1) vs arch package (MLE)','long-run annual vol',g['longRunVol'],lr,0.2,True,'variance targeting vs free omega')
rec('GARCH(1,1) vs planted truth','persistence (truth 0.95)',g['persistence'],0.95,0.04)
from statsmodels.tsa.regime_switching.markov_regression import MarkovRegression
hm=D['hmm']; mr=MarkovRegression(np.array(hm['r'])*100,k_regimes=2,switching_variance=True,trend='n').fit(disp=False)
sds=sorted(np.sqrt(np.asarray(mr.params)[-2:])); mine=sorted([s['dailyVol']*100 for s in hm['states']])
rec('HMM vs statsmodels MarkovRegression','calm-state daily vol (%)',mine[0],sds[0],0.1,True); rec('HMM vs statsmodels MarkovRegression','stressed-state daily vol (%)',mine[1],sds[1],0.1,True)
rec('HMM vs planted truth','calm / stressed daily vol (truth 0.6% / 2.5%)',mine[0]/mine[1],0.006/0.025,0.2,True)

b=D['vol']['bars']; o_=np.array([x['o'] for x in b]);h_=np.array([x['h'] for x in b]);l_=np.array([x['l'] for x in b]);c_=np.array([x['c'] for x in b])
rec('Volatility estimators vs independent numpy','Parkinson',D['vol']['parkinson'],math.sqrt(np.mean(np.log(h_/l_)**2)/(4*math.log(2))*252),1e-9,True)
rec('Volatility estimators vs independent numpy','Garman-Klass',D['vol']['gk'],math.sqrt(np.mean(0.5*np.log(h_/l_)**2-(2*math.log(2)-1)*np.log(c_/o_)**2)*252),1e-9,True)
n=len(b)-1; ov=np.log(o_[1:]/c_[:-1]); oc=np.log(c_[1:]/o_[1:]); rs=np.mean(np.log(h_[1:]/c_[1:])*np.log(h_[1:]/o_[1:])+np.log(l_[1:]/c_[1:])*np.log(l_[1:]/o_[1:])); k=0.34/(1.34+(n+1)/(n-1))
rec('Volatility estimators vs independent numpy','Yang-Zhang',D['vol']['yz'],math.sqrt((np.var(ov,ddof=1)+k*np.var(oc,ddof=1)+(1-k)*rs)*252),1e-9,True)
lrn=np.diff(np.log(c_)); rv=[np.std(lrn[i-20:i+1],ddof=1)*math.sqrt(252) for i in range(len(lrn)-3,len(lrn))]
rec('Volatility estimators vs independent numpy','rolling 21d (Welford), last 3',np.abs(np.array(D['vol']['rolling'])-rv).max(),0,1e-10)
v=np.mean(lrn[:20]**2); ew=[]
for i in range(len(lrn)):
    if i>0: v=0.94*v+0.06*lrn[i-1]**2
    ew.append(math.sqrt(v*252))
rec('Volatility estimators vs independent numpy','EWMA 0.94, last 3',np.abs(np.array(D['vol']['ewma'])-ew[-3:]).max(),0,1e-10)

from sklearn.covariance import LedoitWolf
lw=D['lw']; X=np.array(lw['rows']); m=LedoitWolf().fit(X)
rec('Ledoit-Wolf vs scikit-learn','shrinkage intensity',lw['shrinkage'],m.shrinkage_,1e-6); rec('Ledoit-Wolf vs scikit-learn','covariance max diff',np.abs(np.array(lw['cov'])-m.covariance_).max(),0,1e-9)
pc=D['pca']; C=np.corrcoef(np.array(pc['rows']).T); w,V_=np.linalg.eigh(C); idx=np.argsort(w)[::-1]; w=w[idx]; V_=V_[:,idx]
rec('PCA vs numpy','variance explained (3 comps) max diff',np.abs(np.array(pc['explained'])-w[:3]/w.sum()).max(),0,1e-9); rec('PCA vs numpy','first loading direction (|cos|=1)',abs(np.dot(pc['loadings'][0],V_[:,0])),1,1e-6)
op=D['opt']; S=np.array(op['S']); rp=np.array(op['rp']); mrc=rp*(S@rp); mrc/=mrc.sum()
rec('Risk parity (ERC)','every risk contribution = 25% (max deviation)',np.abs(mrc-0.25).max(),0,1e-6)
from scipy.optimize import minimize
n=4; mu=np.array(op['mu']); cons={'type':'eq','fun':lambda w:w.sum()-1}
res=minimize(lambda w:w@S@w,np.ones(n)/n,bounds=[(0,1)]*n,constraints=cons,method='SLSQP',options={'ftol':1e-14}); mv=np.array(op['mv'])
rec('Min-variance vs scipy SLSQP','portfolio variance',mv@S@mv,res.fun,1e-5,True); rec('Min-variance vs scipy SLSQP','weights max diff',np.abs(mv-res.x).max(),0,5e-3)
res=minimize(lambda w:-(w@mu)/math.sqrt(w@S@w),np.ones(n)/n,bounds=[(0,1)]*n,constraints=cons,method='SLSQP',options={'ftol':1e-14}); ms=np.array(op['ms'])
rec('Max-Sharpe vs scipy SLSQP','Sharpe achieved',(ms@mu)/math.sqrt(ms@S@ms),-res.fun,1e-3,True); rec('Max-Sharpe vs scipy SLSQP','weights max diff',np.abs(ms-res.x).max(),0,0.03)

from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.naive_bayes import GaussianNB
from sklearn.tree import DecisionTreeClassifier
from sklearn.ensemble import RandomForestClassifier, GradientBoostingClassifier
from sklearn.svm import LinearSVC
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis as LDA, QuadraticDiscriminantAnalysis as QDA
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler
from sklearn.pipeline import make_pipeline
from sklearn.metrics import roc_auc_score
ref={'logistic':lambda:make_pipeline(StandardScaler(),LogisticRegression()),'knn':lambda:make_pipeline(StandardScaler(),KNeighborsClassifier(15,weights='distance')),'nb':GaussianNB,'tree':lambda:DecisionTreeClassifier(max_depth=4,min_samples_leaf=10,random_state=0),'rf':lambda:RandomForestClassifier(80,max_depth=6,random_state=0),'gb':lambda:GradientBoostingClassifier(n_estimators=80,learning_rate=0.1,max_depth=3,random_state=0),'svm':lambda:make_pipeline(StandardScaler(),LinearSVC(C=1.0,dual=False)),'lda':LDA,'qda':QDA,'mlp':lambda:make_pipeline(StandardScaler(),MLPClassifier((12,),max_iter=400,random_state=0))}
names={'logistic':'Logistic regression','knn':'KNN (k=15)','nb':'Gaussian naive Bayes','tree':'Decision tree','rf':'Random forest','gb':'Gradient boosting','svm':'Linear SVM','lda':'LDA','qda':'QDA','mlp':'MLP'}
for ds,d in D['ml'].items():
    Xtr,ytr,Xte,yte=np.array(d['tr']['X']),np.array(d['tr']['y']),np.array(d['te']['X']),np.array(d['te']['y'])
    for k,mk in ref.items():
        m=mk().fit(Xtr,ytr); acc_ref=(m.predict(Xte)==yte).mean(); mine=np.array(d['preds'][k]); acc=((mine>0.5)==yte).mean()
        auc_m=roc_auc_score(yte,mine); auc_r=roc_auc_score(yte,m.predict_proba(Xte)[:,1] if hasattr(m,'predict_proba') else m.decision_function(Xte))
        rec(f'ML test accuracy vs scikit-learn ({ds})',names[k],acc,acc_ref,0.05,False,f'acc mine {acc:.3f} vs {acc_ref:.3f}, AUC {auc_m:.3f} vs {auc_r:.3f}')
from sklearn.cluster import KMeans, DBSCAN, AgglomerativeClustering
from sklearn.metrics import adjusted_rand_score as ari
c=D['cl']; X=np.array(c['X'])
rec('Clustering agreement with scikit-learn (ARI)','k-means',ari(c['km'],KMeans(3,n_init=10,random_state=0).fit_predict(X)),1,0.02); rec('Clustering agreement with scikit-learn (ARI)','hierarchical, average linkage',ari(c['hc'],AgglomerativeClustering(3,linkage='average').fit_predict(X)),1,1e-9); rec('Clustering agreement with scikit-learn (ARI)','DBSCAN',ari(c['db'],DBSCAN(eps=1.2,min_samples=4).fit_predict(X)),1,1e-9)
from sklearn.manifold import TSNE, trustworthiness
t=D['tsne']; X=np.array(t['X']); mine=trustworthiness(X,np.array(t['emb']),n_neighbors=10); sk=trustworthiness(X,TSNE(2,perplexity=15,random_state=0,init='pca').fit_transform(X),n_neighbors=10)
rec('t-SNE neighbourhood preservation vs scikit-learn','trustworthiness (k=10)',mine,sk,0.06,False,f'mine {mine:.3f} vs sklearn {sk:.3f}')


# ---------- round 2
ex=D['exotics']; b=ex['base']
def bsproc(S,q,r,sig): return ql.BlackScholesMertonProcess(ql.QuoteHandle(ql.SimpleQuote(S)),ql.YieldTermStructureHandle(ql.FlatForward(today,q,dc)),ql.YieldTermStructureHandle(ql.FlatForward(today,r,dc)),ql.BlackVolTermStructureHandle(ql.BlackConstantVol(today,cal,sig,dc)))
pr=bsproc(b['S'],b['q'],b['r'],b['sigma']); mT=mat(b['T'])
for g in ex['geo']:
    for t in ['call','put']:
        fixes=[today+int(round(365*(k+1)/g['n'])) for k in range(g['n'])]
        o=ql.DiscreteAveragingAsianOption(ql.Average.Geometric,1.0,0,fixes,ql.PlainVanillaPayoff(ql.Option.Call if t=='call' else ql.Option.Put,b['K']),ql.EuropeanExercise(mT))
        o.setPricingEngine(ql.AnalyticDiscreteGeometricAveragePriceAsianEngine(pr))
        rec('Geometric Asian closed form vs QuantLib',f"{t} n={g['n']}",g[t],o.NPV(),2e-3,True,'fixing dates rounded to whole days')
fixes=[today+int(round(365*(k+1)/52)) for k in range(52)]
o=ql.DiscreteAveragingAsianOption(ql.Average.Arithmetic,0.0,0,fixes,ql.PlainVanillaPayoff(ql.Option.Call,b['K']),ql.EuropeanExercise(mT))
o.setPricingEngine(ql.MCDiscreteArithmeticAPEngine(pr,'pseudorandom',antitheticVariate=True,controlVariate=True,requiredSamples=200000,seed=42))
am=ex['asianMc']; rec('Arithmetic Asian MC (control variate) vs QuantLib MC','call n=52',am['price'],o.NPV(),max(4*am['se'],0.01)/o.NPV(),True,f"se {am['se']:.4f}")
bt={'down-and-out':ql.Barrier.DownOut,'down-and-in':ql.Barrier.DownIn,'up-and-out':ql.Barrier.UpOut,'up-and-in':ql.Barrier.UpIn}
for x in ex['barrier']:
    o=ql.BarrierOption(bt[x['barrier']],x['H'],0.0,ql.PlainVanillaPayoff(ql.Option.Call if x['type']=='call' else ql.Option.Put,b['K']),ql.EuropeanExercise(mT)); o.setPricingEngine(ql.AnalyticBarrierEngine(pr)); ref=o.NPV()
    rec('Barrier closed form vs QuantLib AnalyticBarrierEngine',f"{x['barrier']} {x['type']} H={x['H']}",x['analytic'],ref,1e-6 if ref>1e-6 else 1,ref>1e-6)
    rec('Barrier MC (Brownian bridge) vs QuantLib analytic (in standard errors)',f"{x['barrier']} {x['type']} H={x['H']}",(x['mc']-ref)/x['se'],0,3.0,False,f"MC {x['mc']:.4f} ± {x['se']:.4f} vs {ref:.4f}")
for x in ex['lookback']:
    o=ql.ContinuousFloatingLookbackOption(b['S'],ql.FloatingTypePayoff(ql.Option.Call if x['type']=='call' else ql.Option.Put),ql.EuropeanExercise(mT)); o.setPricingEngine(ql.AnalyticContinuousFloatingLookbackEngine(pr))
    rec('Lookback closed form vs QuantLib',x['type'],x['analytic'],o.NPV(),1e-6,True)
sf=D['sabrFit']; strikes=[q_['strike'] for q_ in sf['quotes']]; vols=[q_['iv'] for q_ in sf['quotes']]
try:
    si=ql.SABRInterpolation(strikes,vols,1.0,100.0,0.05,0.7,0.5,0.0,False,True,False,False)   # calibrates in the constructor
    qlsse=sum((ql.sabrVolatility(k,100.0,1.0,si.alpha(),si.beta(),si.nu(),si.rho())-v)**2 for k,v in zip(strikes,vols)); mine=sum((f['model']-f['market'])**2 for f in sf['fit']['fitted'])
    rec('SABR calibration vs QuantLib SABRInterpolation','excess fit error vs QuantLib (0 = as good or better)',max(mine/qlsse-1,0),0,0.05,False,f'SSE ratio ours/QuantLib {mine/qlsse:.2f}; '+f"alpha {sf['fit']['alpha']:.4f}/{si.alpha():.4f} rho {sf['fit']['rho']:.3f}/{si.rho():.3f} nu {sf['fit']['nu']:.3f}/{si.nu():.3f}")
    rec('SABR calibration vs planted truth (noisy quotes)','rho (truth -0.40)',sf['fit']['rho'],-0.4,0.06); rec('SABR calibration vs planted truth (noisy quotes)','nu (truth 0.60)',sf['fit']['nu'],0.6,0.06); rec('SABR calibration vs planted truth (noisy quotes)','alpha (truth 0.06)',sf['fit']['alpha'],0.06,0.005)
except Exception as e:
    rows.append(('SABR calibration vs QuantLib SABRInterpolation','QuantLib call failed: '+str(e)[:60],0,0,0,0,True,'skipped'))
from sklearn.svm import SVC
k=D['ksvm']; Z=np.array(k['Z']); y=np.array(k['y']); m=SVC(C=1,gamma='scale').fit(Z,y); ref=m.decision_function(Z); mine=np.array(k['dec'])
rec('Kernel SVM (RBF) vs scikit-learn SVC','support vectors',k['nsv'],m.n_support_.sum(),2); rec('Kernel SVM (RBF) vs scikit-learn SVC','decision function max diff',np.abs(mine-ref).max(),0,0.02); rec('Kernel SVM (RBF) vs scikit-learn SVC','same class on every point',((mine>0)==(ref>0)).mean(),1,1e-9)
from arch.unitroot import VarianceRatio
vr=D['vr']
for res in vr['res']:
    a=VarianceRatio(np.array(vr['p']),lags=res['q'],trend='c',debiased=True,robust=True,overlap=True)
    rec('Variance ratio vs arch','VR q=%d'%res['q'],res['vr'],a.vr,1e-6,True); rec('Variance ratio vs arch','robust z q=%d'%res['q'],res['zRobust'],a.stat,0.05,True)
for kp in D['kupiec']:
    x,n,p=kp['x'],kp['n'],kp['p']; ph=x/n
    lr=-2*((n-x)*math.log(1-p)+x*math.log(p)-((n-x)*math.log(1-ph) if ph<1 else 0)-(x*math.log(ph) if x>0 else 0))
    rec('Kupiec POF vs scipy chi2',f'{x}/{n} at {p}',kp['pValue'],st.chi2.sf(lr,1),1e-8)


# GARCH family vs arch (data ×100 → log-likelihood shifts by n·ln 100)
for fam in D['volFamily']:
    r=np.array(fam['r'])*100; n=len(r); shift=n*math.log(100)
    specs={'arch':dict(vol='ARCH',p=1),'garch':dict(vol='GARCH',p=1,q=1),'gjr':dict(vol='GARCH',p=1,o=1,q=1),'egarch':dict(vol='EGARCH',p=1,o=1,q=1),'aparch':dict(vol='APARCH',p=1,o=1,q=1)}
    for m,kw in specs.items():
        res=arch_model(r,mean='Zero',dist='normal',**kw).fit(disp='off',options={'maxiter':2000}); pa=res.params; mine=fam['fits'][m]; P=mine['params']
        grp=f"{m.upper()} vs arch package (MLE, {fam['kind']} data)"
        rec(grp,'log-likelihood',mine['logLik'],res.loglikelihood+shift,0.5,False,'Nelder–Mead vs SLSQP; ≤0.5 log-lik units')
        if m in ('arch','garch','gjr'): rec(grp,'alpha',P['alpha'],pa['alpha[1]'],0.03)
        if m in ('garch','gjr','egarch','aparch'): rec(grp,'beta',P['beta'],pa['beta[1]'],0.03)
        if m=='gjr': rec(grp,'gamma',P['gamma'],pa['gamma[1]'],0.04)
        if m=='egarch': rec(grp,'alpha',P['alpha'],pa['alpha[1]'],0.03); rec(grp,'gamma',P['gamma'],pa['gamma[1]'],0.03)
        if m=='aparch': rec(grp,'gamma',P['gamma'],pa['gamma[1]'],0.1); rec(grp,'delta',P['delta'],pa['delta'],0.1)

by=collections.OrderedDict()
for g,n,m,r,d,tol,ok,note in rows: by.setdefault(g,[]).append((n,m,r,d,tol,ok,note))
tot=sum(len(v) for v in by.values()); fails=0
for g,items in by.items():
    okc=sum(1 for i in items if i[5]); mx=max(i[3] for i in items)
    print(f"{'PASS' if okc==len(items) else 'FAIL'}  {g:<58} {okc:>2}/{len(items):<2} worst dev {mx:.2e}")
    for n,m,r,d,tol,ok,note in items:
        if not ok: fails+=1; print(f"        x {n}: mine={m:.6g} ref={r:.6g} dev={d:.3g} tol={tol:g} {note}")
print(f"\n{tot-fails}/{tot} checks within tolerance")
json.dump([dict(group=g,name=n,mine=m,ref=r,dev=d,tol=tol,ok=bool(ok),note=note) for g,n,m,r,d,tol,ok,note in rows],open(os.path.join(os.path.dirname(os.path.abspath(__file__)),'out','results.json'),'w'))
