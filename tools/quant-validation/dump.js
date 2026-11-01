const path=require('path');const R=path.join(__dirname,'..','..','lib','quant')+path.sep;const L=require(R+'linalg'),O=require(R+'options'),V=require(R+'volatility'),T=require(R+'timeseries'),OP=require(R+'optimize'),RK=require(R+'risk'),ML=require(R+'ml'),NN=require(R+'neural');
const out={};
// ---- options
const cases=[{S:100,K:100,r:0.05,q:0,sigma:0.2,T:1},{S:100,K:110,r:0.03,q:0.02,sigma:0.3,T:0.4},{S:80,K:100,r:0.05,q:0,sigma:0.25,T:2},{S:120,K:100,r:0.01,q:0.03,sigma:0.15,T:0.2},{S:50,K:55,r:0.08,q:0,sigma:0.4,T:1.6}];
out.options=cases.flatMap(c=>['call','put'].map(type=>{const a={...c,type};return{...a,bs:O.blackScholes(a),greeks:O.greeks(a),iv:O.impliedVol({price:O.blackScholes(a),...a}),amBinomial:O.binomial({...a,n:1000,american:true}),euBinomial:O.binomial({...a,n:1000,american:false}),amFD:O.finiteDiff({...a,M:400,N:400,american:true}),euFD:O.finiteDiff({...a,M:400,N:400,american:false}),lsm:type==='put'?O.lsm({...a,paths:40000,steps:50,seed:7}):null}}));
out.heston=[{S:100,K:100,r:0.03,T:1,q:0,v0:0.04,kappa:2,theta:0.04,xi:0.5,rho:-0.7},{S:100,K:90,r:0.02,T:0.4,q:0.01,v0:0.06,kappa:1.5,theta:0.05,xi:0.8,rho:-0.5},{S:100,K:120,r:0.05,T:2,q:0,v0:0.03,kappa:3,theta:0.04,xi:0.4,rho:0.2},{S:100,K:100,r:0.03,T:5,q:0,v0:0.04,kappa:0.8,theta:0.06,xi:0.9,rho:-0.8}].map(a=>({...a,call:O.heston({...a,type:'call'}),put:O.heston({...a,type:'put'})}));
out.sabr=[{F:100,K:90,T:1,alpha:0.2,beta:1,rho:-0.4,nu:0.5},{F:100,K:110,T:2,alpha:0.05,beta:0.7,rho:-0.3,nu:0.6},{F:100,K:100,T:0.5,alpha:0.3,beta:0.5,rho:0.2,nu:0.3},{F:0.03,K:0.035,T:5,alpha:0.025,beta:0.5,rho:-0.2,nu:0.4}].map(a=>({...a,vol:O.sabrVol(a)}));
// ---- special functions
out.special={x:[-3,-1.2,0,0.4,2.5],cdf:[-3,-1.2,0,0.4,2.5].map(L.normCdf),p:[0.001,0.05,0.5,0.9,0.999],inv:[0.001,0.05,0.5,0.9,0.999].map(L.normInv),chi2:[[3.84,1],[18.307,10],[7.8,3],[40,25]].map(([x,k])=>[x,k,T.chi2Sf(x,k)]),beta:[[0.3,2,5],[0.5,8,3],[0.9,60,41]].map(([x,a,b])=>[x,a,b,RK.betaCdf(x,a,b)]),bayes:RK.bayesBinomial(37,60)};
// ---- linear algebra
const g=L.rng(1);const A=[[4,1,0.5,0.2],[1,3,0.3,0.1],[0.5,0.3,2,0.4],[0.2,0.1,0.4,1.5]];out.la={A,chol:L.cholesky(A),eig:L.jacobiEigen(A),inv:L.inverse(A)};
const Xo=Array.from({length:300},()=>[g.normal(),g.normal()]),yo=Xo.map(r=>1+2*r[0]-0.5*r[1]+0.3*g.normal());const f=L.ols(Xo,yo);out.ols={X:Xo,y:yo,beta:f.beta,tstat:f.tstat,r2:f.r2,se:f.se};
// ---- time series
const walk=(n,s)=>{const r=L.rng(s);let p=0;return Array.from({length:n},()=>(p+=r.normal()))};const ar1=(n,phi,s)=>{const r=L.rng(s);let p=0;return Array.from({length:n},()=>(p=phi*p+r.normal()))};
const rw=walk(600,3),st=ar1(600,0.6,4),x=walk(600,5),nz=ar1(600,0.7,6),y=x.map((v,i)=>2+1.3*v+nz[i]),y2=walk(600,8);
out.ts={rw,st,x,y,y2,adfRw:T.adf(rw),adfSt:T.adf(st),egCoint:{stat:T.engleGranger(y,x).adfStat,hr:T.engleGranger(y,x).hedgeRatio},egIndep:{stat:T.engleGranger(y2,x).adfStat},ou:T.ouHalfLife(st),ljung:T.ljungBox(st,10),acf:T.acf(st,5)};
const ar2=(n,s)=>{const r=L.rng(s);let a=0,b=0;return Array.from({length:n},()=>{const v=0.5*a-0.2*b+r.normal();b=a;a=v;return v})};
const a2=ar2(500,9);const ar=T.arima(a2,{p:2,d:0,q:0,horizon:10});out.arima={y:a2,fit:{p:ar.p,d:ar.d,q:ar.q},fc:ar.forecast.map(f=>f.mean),sigma:ar.sigma};
const rvw=walk(500,10).map(v=>v+100);const ar2b=T.arima(rvw,{p:1,d:1,q:0,horizon:5});out.arima2={y:rvw,fc:ar2b.forecast.map(f=>f.mean)};
// garch data
const gg=L.rng(11);let h=2e-6/(1-0.1-0.85);const gr=[];for(let i=0;i<3000;i++){const e=Math.sqrt(h)*gg.normal();gr.push(e);h=2e-6+0.1*e*e+0.85*h}
const gf=V.garch11(gr);out.garch={r:gr,alpha:gf.alpha,beta:gf.beta,persistence:gf.persistence,longRunVol:gf.longRunVol,ll:gf.logLik};
// hmm data
const hh=L.rng(12);const hr=[];for(let i=0;i<1500;i++){const s=(i%500)>=380;hr.push((s?0.025:0.006)*hh.normal())}const hm=T.hmm2(hr);out.hmm={r:hr,states:hm.states,trans:hm.transition};
// bars for vol estimators
const bg=L.rng(13);let p=100;const bars=[];for(let i=0;i<400;i++){const o=p*(1+0.003*bg.normal());let hi=o,lo=o,c=o;for(let s=0;s<30;s++){c*=1+0.25/Math.sqrt(252*30)*bg.normal();hi=Math.max(hi,c);lo=Math.min(lo,c)}bars.push({o,h:hi,l:lo,c});p=c}
out.vol={bars,parkinson:V.parkinson(bars),gk:V.garmanKlass(bars),yz:V.yangZhang(bars),rolling:V.rollingVol(L.logReturnsOf(bars.map(b=>b.c)),21).slice(-3),ewma:V.ewmaVol(L.logReturnsOf(bars.map(b=>b.c))).slice(-3)};
// ---- portfolio / LW / PCA
const fac=Array.from({length:150},()=>g.normal());const rows=fac.map(fv=>Array.from({length:8},(_,j)=>0.01*(fv*(0.5+0.1*j)+0.8*g.normal())));const lw=OP.ledoitWolf(rows);out.lw={rows,shrinkage:lw.shrinkage,cov:lw.cov};
const pc=RK.pca(rows,{components:3});out.pca={rows,explained:pc.explained,loadings:pc.loadings};
const mu=[0.04,0.06,0.09,0.12],vols=[0.1,0.15,0.22,0.3],S=vols.map((a,i)=>vols.map((b,j)=>i===j?a*a:0.3*a*b));const rp=OP.riskParity(S);out.opt={S,rp,rc:OP.riskContributions(rp,S),mv:OP.minVariance(S),ms:OP.maxSharpe(mu,S),mu};
// ---- ML datasets
function mkCircles(n,s){const r=L.rng(s),X=[],y=[];for(let i=0;i<n;i++){const c=i%2,rad=(c?1.6:0.7)+0.25*r.normal(),a=r.uniform()*6.283;X.push([rad*Math.cos(a),rad*Math.sin(a),r.normal()]);y.push(c)}return{X,y}}
function mkBlobs(n,s){const r=L.rng(s),X=[],y=[];for(let i=0;i<n;i++){const c=i%2;X.push([r.normal()+(c?1.8:0),r.normal()+(c?1.8:0),r.normal()]);y.push(c)}return{X,y}}
out.ml={};for(const [nm,mk] of [['circles',mkCircles],['blobs',mkBlobs]]){const tr=mk(500,21),te=mk(500,22),res={};for(const [k,m] of Object.entries({logistic:()=>ML.logistic(),knn:()=>ML.knn({k:15}),nb:()=>ML.gaussianNB(),tree:()=>ML.decisionTree({maxDepth:4,minLeaf:10}),rf:()=>ML.randomForest({trees:80,maxDepth:6}),gb:()=>ML.gradientBoosting({rounds:80}),svm:()=>ML.linearSVM(),lda:()=>ML.lda(),qda:()=>ML.qda(),mlp:()=>NN.mlp({hidden:12,epochs:80})})){const mm=m().fit(tr.X,tr.y);res[k]=mm.predictProba(te.X)}out.ml[nm]={tr,te,preds:res}}
// ---- clustering
const cg=L.rng(31),cx=[],ct=[];[[0,0],[7,0],[3.5,6]].forEach((c,k)=>{for(let i=0;i<50;i++){cx.push([c[0]+cg.normal()*0.7,c[1]+cg.normal()*0.7]);ct.push(k)}});out.cl={X:cx,truth:ct,km:ML.kmeans(cx,3,{seed:3}).labels,hc:ML.hierarchical(cx,3).labels,db:ML.dbscan(cx,{eps:1.2,minPts:4}).labels};
const tg=L.rng(32),tx=[];[0,1,2].forEach(k=>{for(let i=0;i<40;i++)tx.push(Array.from({length:8},(_,j)=>(j===k?6:0)+tg.normal()*0.6))});out.tsne={X:tx,emb:ML.tsne(tx,{perplexity:15,iters:400,seed:2}).embedding};

// ---- round 2: exotics, calibration, kernel SVM, variance ratio, Kupiec
const X=require(R+'exotics'),TSm=require(R+'timeseries'),VB=require(R+'var-backtest');
const ex={S:100,K:100,r:0.05,q:0.01,sigma:0.25,T:1};
out.exotics={base:ex,geo:[12,52,252].map(n=>({n,call:X.geometricAsian({...ex,n,type:'call'}),put:X.geometricAsian({...ex,n,type:'put'})})),
  asianMc:X.asian({...ex,fixings:52,paths:60000,seed:5}),
  barrier:[['down-and-out','call',85],['down-and-in','call',85],['up-and-out','call',130],['up-and-in','call',130],['down-and-out','put',80],['up-and-out','put',120],['down-and-in','put',80],['up-and-in','put',120]].map(([b,t,H])=>({barrier:b,type:t,H,analytic:X.barrierAnalytic({...ex,H,type:t,barrier:b}),...(m=>({mc:m.price,se:m.se}))(X.barrier({...ex,H,type:t,barrier:b,steps:100,paths:30000,seed:7}))})),
  lookback:['call','put'].map(t=>({type:t,analytic:X.lookbackAnalytic({...ex,type:t})}))};
const sq=[70,80,90,95,100,105,110,120,130].map(K=>({strike:K,iv:O.sabrVol({F:100,K,T:1,beta:0.7,alpha:0.06,rho:-0.4,nu:0.6})+0.002*Math.sin(K)}));out.sabrFit={quotes:sq,fit:O.calibrateSabr({F:100,T:1,beta:0.7,quotes:sq})};
const sv=L.rng(41),sX=[],sy=[];for(let i=0;i<600;i++){const c=i%2,rad=(c?1.6:0.7)+0.25*sv.normal(),a=sv.uniform()*6.283;sX.push([rad*Math.cos(a),rad*Math.sin(a),sv.normal()]);sy.push(c)}
const sscZ=ML.scaler(sX).transform(sX),km=ML.kernelSVM({C:1}).fit(sX,sy);out.ksvm={Z:sscZ,y:sy,dec:km.decisionFunction(sX),nsv:km.supportVectors};
const vrr=L.rng(42);let lp=0,e0=0;const lps=Array.from({length:2000},()=>{e0=0.15*e0+0.01*vrr.normal();return(lp+=e0)});out.vr={p:lps,res:[2,5,10].map(q=>TSm.varianceRatio(lps,q))};
out.kupiec=[[10,1000,0.01],[25,1000,0.01],[3,500,0.05],[40,500,0.05]].map(([x,n,p])=>({x,n,p,...VB.kupiec(x,n,p)}));
require('fs').mkdirSync(path.join(__dirname,'out'),{recursive:true});require('fs').writeFileSync(path.join(__dirname,'out','dump.json'),JSON.stringify(out));console.log('dumped',Object.keys(out).join(','));
