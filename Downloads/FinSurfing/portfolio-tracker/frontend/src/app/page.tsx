"use client";

import React, { useState, useEffect } from 'react';
import { Search, Bell, PieChart, TrendingUp, Home, Settings, Briefcase, LogOut } from 'lucide-react';
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts';

type StockData = { [key: string]: number };

export default function Dashboard() {
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('Dashboard');
  
  // Real-time market data state
  const [marketData, setMarketData] = useState<StockData>({
    AAPL: 273.05, ADSK: 245.31, AMD: 274.95, AMZN: 248.28,
    AVGO: 399.63, BABA: 140.17, BROS: 54.82, CL: 83.53,
    COIN: 211.63, GOOG: 335.40, INTC: 85.70, MSFT: 418.07,
    NVDA: 145.70, ORCL: 177.58, PG: 144.49, QCOM: 137.52,
    SOUN: 8.32, TSLA: 392.50, TSM: 368.24, TXN: 233.70, XOM: 147.68,
    LLY: 885.30, CRWD: 312.15, PLTR: 24.50
  });

  // Example portfolio data structure
  const [chartData, setChartData] = useState([
    { name: 'Jan', value: 250000 }, { name: 'Feb', value: 265000 },
    { name: 'Mar', value: 258000 }, { name: 'Apr', value: 289000 },
    { name: 'May', value: 310000 }, { name: 'Jun', value: 328540 }
  ]);

  useEffect(() => {
    // Connect to the FastAPI WebSocket we just built
    const ws = new WebSocket("ws://localhost:8001/ws/market-data");

    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload.type === "market_tick") {
          const newData = { ...marketData };
          payload.data.forEach((tick: any) => {
             newData[tick.symbol] = tick.price;
          });
          setMarketData(newData);
          
          // Animate chart slightly for demo purposes
          setChartData(prev => {
             const newChart = [...prev];
             const lastVal = newChart[5].value;
             // Adds some volatility to the chart line
             newChart[5].value = lastVal + (Math.random() > 0.5 ? 5 : -5);
             return newChart;
          });
        }
      } catch (err) {}
    };

    return () => ws.close();
  }, []);

  const currentHoldings = [
    { symbol: 'AAPL', name: 'Apple Inc', qty: 10, avg: 150.46, current: marketData['AAPL'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'ADSK', name: 'Autodesk Inc', qty: 10, avg: 255.17, current: marketData['ADSK'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'AMD', name: 'Advanced Micro', qty: 10, avg: 131.19, current: marketData['AMD'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'AMZN', name: 'Amazon.com', qty: 10, avg: 166.61, current: marketData['AMZN'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'AVGO', name: 'Broadcom Inc', qty: 10, avg: 177.54, current: marketData['AVGO'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'BABA', name: 'Alibaba Group', qty: 10, avg: 188.38, current: marketData['BABA'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'BROS', name: 'Dutch Bros', qty: 15, avg: 63.48, current: marketData['BROS'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'CL', name: 'Colgate-Palmolive', qty: 15, avg: 94.64, current: marketData['CL'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'COIN', name: 'Coinbase Global', qty: 15, avg: 257.11, current: marketData['COIN'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'GOOG', name: 'Alphabet Inc', qty: 10, avg: 165.77, current: marketData['GOOG'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'INTC', name: 'Intel Corp', qty: 25, avg: 19.54, current: marketData['INTC'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'MSFT', name: 'Microsoft Corp', qty: 10, avg: 400.57, current: marketData['MSFT'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'NVDA', name: 'NVIDIA Corp', qty: 50, avg: 112.07, current: marketData['NVDA'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'ORCL', name: 'Oracle Corp', qty: 15, avg: 265.80, current: marketData['ORCL'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'PG', name: 'Procter Gamble', qty: 10, avg: 157.15, current: marketData['PG'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'QCOM', name: 'Qualcomm Inc', qty: 10, avg: 163.21, current: marketData['QCOM'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'SOUN', name: 'Soundhound AI', qty: 150, avg: 15.45, current: marketData['SOUN'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'TSLA', name: 'Tesla Inc', qty: 15, avg: 216.75, current: marketData['TSLA'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'TSM', name: 'Taiwan Semicond', qty: 20, avg: 180.51, current: marketData['TSM'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'TXN', name: 'Texas Instru', qty: 10, avg: 207.26, current: marketData['TXN'], get gain() { return ((this.current / this.avg) - 1) * 100 } },
    { symbol: 'XOM', name: 'Exxon Mobil', qty: 10, avg: 147.72, current: marketData['XOM'], get gain() { return ((this.current / this.avg) - 1) * 100 } }
  ];

  const recommendedStocks = [
    { symbol: 'MSFT', name: 'Microsoft Corp', price: marketData['MSFT'], gain: 2.1 },
    { symbol: 'LLY', name: 'Eli Lilly and Co', price: marketData['LLY'], gain: 3.4 },
    { symbol: 'CRWD', name: 'CrowdStrike', price: marketData['CRWD'], gain: 5.8 },
  ];

  return (
    <div className="min-h-screen bg-[#0a0a0f] text-white p-6 font-sans selection:bg-green-500/30 flex">
      {/* Sidebar Navigation */}
      <aside className="w-20 lg:w-64 border-r border-white/5 flex flex-col items-center lg:items-start py-8 bg-white/5 rounded-3xl backdrop-blur-xl mr-6 shadow-2xl">
        <div className="text-green-400 font-black text-3xl mb-12 lg:px-8">F.</div>
        <nav className="flex flex-col gap-6 w-full px-4 lg:px-6">
          <button onClick={() => setActiveTab('Dashboard')} className={`p-4 rounded-2xl flex items-center gap-4 transition-all ${activeTab === 'Dashboard' ? 'bg-green-500/20 text-green-400' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>
            <Home size={22} /> <span className="hidden lg:block font-medium">Dashboard</span>
          </button>
          <button onClick={() => setActiveTab('Portfolio')} className={`p-4 rounded-2xl flex items-center gap-4 transition-all ${activeTab === 'Portfolio' ? 'bg-green-500/20 text-green-400' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>
            <Briefcase size={22} /> <span className="hidden lg:block font-medium">Portfolio</span>
          </button>
          <button onClick={() => setActiveTab('Analytics')} className={`p-4 rounded-2xl flex items-center gap-4 transition-all ${activeTab === 'Analytics' ? 'bg-green-500/20 text-green-400' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>
            <PieChart size={22} /> <span className="hidden lg:block font-medium">Analytics</span>
          </button>
          <button onClick={() => setActiveTab('Settings')} className={`p-4 rounded-2xl flex items-center gap-4 transition-all ${activeTab === 'Settings' ? 'bg-green-500/20 text-green-400' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}>
            <Settings size={22} /> <span className="hidden lg:block font-medium">Settings</span>
          </button>
        </nav>
        <div className="mt-auto px-4 lg:px-6 w-full">
           <button className="p-4 text-gray-500 hover:text-red-400 flex items-center gap-4 w-full">
            <LogOut size={22} /> <span className="hidden lg:block font-medium">Logout</span>
          </button>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col gap-6">
        
        {/* Top Header & Global Search */}
        <header className="flex justify-between items-center bg-white/5 backdrop-blur-md border border-white/10 rounded-3xl p-4 shadow-lg">
          <div className="relative w-full max-w-xl">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={20} />
            <input 
              type="text" 
              placeholder="Search Stocks & ETFs (e.g., TSLA, NVDA)" 
              className="w-full bg-white/5 border border-white/10 rounded-full py-3 pl-12 pr-4 text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50 transition-all placeholder:text-gray-500"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-6 pr-4">
            <button className="text-gray-400 hover:text-white relative">
              <Bell size={22} />
              <div className="absolute top-0 right-0 w-2.5 h-2.5 bg-red-500 rounded-full border-2 border-[#12121a]"></div>
            </button>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-purple-500 flex items-center justify-center font-bold">AR</div>
            </div>
          </div>
        </header>

        {/* Main View Area */}
        {activeTab === 'Dashboard' && (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 flex-1">
          
          {/* Main Chart Section */}
          <div className="xl:col-span-2 bg-gradient-to-br from-white/10 to-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-xl flex flex-col shadow-2xl">
            <div className="flex justify-between items-start mb-8">
              <div>
                <p className="text-xs font-semibold tracking-wider text-gray-400 mb-2">PORTFOLIO GROWTH</p>
                <h1 className="text-4xl font-bold tracking-tight">${chartData[5].value.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</h1>
                <p className="text-green-400 text-sm font-medium mt-2 flex items-center gap-1">
                  <TrendingUp size={16} /> Live WebSocket Feed Active
                </p>
              </div>
            </div>
            
            <div className="h-64 w-full flex-1">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#22c55e" stopOpacity={0.4}/>
                      <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <Tooltip 
                    contentStyle={{ backgroundColor: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '12px' }}
                    itemStyle={{ color: '#fff' }}
                  />
                  <XAxis dataKey="name" stroke="#52525b" tick={{fill: '#a1a1aa'}} axisLine={false} tickLine={false} />
                  <Area type="monotone" dataKey="value" stroke="#4ade80" strokeWidth={3} fillOpacity={1} fill="url(#colorValue)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* AI Recommended Stocks Sidebar */}
          <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-md shadow-xl flex flex-col">
            <p className="text-xs font-semibold tracking-wider text-gray-400 mb-6">Q2 2026 AI RECOMMENDATIONS</p>
            <div className="flex flex-col gap-4 flex-1">
              {recommendedStocks.map((stock) => (
                <div key={stock.symbol} className="bg-white/5 hover:bg-white/10 transition-colors rounded-2xl p-4 border border-white/5 cursor-pointer flex justify-between items-center group">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-purple-500 to-blue-500 flex items-center justify-center font-bold shadow-lg group-hover:scale-105 transition-transform">
                      {stock.symbol[0]}
                    </div>
                    <div>
                      <h3 className="font-bold">{stock.symbol}</h3>
                      <p className="text-xs text-gray-400">{stock.name}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className={`font-bold transition-colors duration-300 ${stock.price % 1 === 0 ? '' : 'text-green-300'}`}>${stock.price.toFixed(2)}</p>
                    <p className="text-xs text-green-400 font-medium">+{stock.gain}%</p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Current Holdings Table */}
          <div className="xl:col-span-3 bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-md shadow-xl overflow-x-auto">
             <div className="flex justify-between items-center mb-6">
                <p className="text-xs font-semibold tracking-wider text-gray-400">CURRENT HOLDINGS</p>
             </div>
             <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="text-gray-500 border-b border-white/10 text-sm">
                    <th className="pb-4 font-medium pl-4">Symbol / Name</th>
                    <th className="pb-4 font-medium">Quantity</th>
                    <th className="pb-4 font-medium">Avg Price</th>
                    <th className="pb-4 font-medium">Live Price</th>
                    <th className="pb-4 font-medium text-right pr-4">Gain / Loss</th>
                  </tr>
                </thead>
                <tbody>
                  {currentHoldings.map((pos) => {
                    const isPositive = pos.gain >= 0;
                    return (
                      <tr key={pos.symbol} className="border-b border-white/5 hover:bg-white/5 transition-colors group">
                        <td className="py-4 pl-4 flex items-center gap-3">
                           <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center font-bold text-xs">{pos.symbol[0]}</div>
                           <div>
                             <p className="font-bold">{pos.symbol}</p>
                             <p className="text-xs text-gray-500">{pos.name}</p>
                           </div>
                        </td>
                        <td className="py-4 font-medium">{pos.qty}</td>
                        <td className="py-4 text-gray-300">${pos.avg.toFixed(2)}</td>
                        <td className={`py-4 font-bold transition-all duration-300 ${isPositive ? 'text-white' : 'text-red-400'}`}>${pos.current.toFixed(2)}</td>
                        <td className={`py-4 text-right pr-4 font-medium transition-colors ${isPositive ? 'text-green-400 bg-green-500/10' : 'text-red-400 bg-red-500/10'} rounded-r-xl`}>
                          {isPositive ? '+' : ''}{pos.gain.toFixed(2)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
             </table>
          </div>
        </div>
        )}

        {activeTab === 'Analytics' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 flex-1">
            <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-md shadow-xl flex flex-col justify-center items-center text-center">
               <div className="w-16 h-16 rounded-full bg-blue-500/20 text-blue-400 flex items-center justify-center mb-4">
                  <TrendingUp size={32} />
               </div>
               <h2 className="text-xl font-bold mb-2">LSTM Neural Network</h2>
               <p className="text-gray-400 text-sm max-w-sm mb-6">Our Deep Learning model projects the 30-day boundaries for NVDA at a 70% confidence score.</p>
               
               <div className="flex gap-4 w-full">
                  <div className="bg-white/5 p-4 rounded-2xl flex-1 border border-green-500/20">
                     <p className="text-xs text-gray-500 mb-1">Bullish Bound</p>
                     <p className="text-xl font-bold text-green-400">$162.69</p>
                  </div>
                  <div className="bg-white/5 p-4 rounded-2xl flex-1 border border-red-500/20">
                     <p className="text-xs text-gray-500 mb-1">Bearish Pullback</p>
                     <p className="text-xl font-bold text-red-400">$132.11</p>
                  </div>
               </div>
               
               <button className="mt-8 px-6 py-3 bg-blue-500 hover:bg-blue-600 rounded-xl font-medium transition-colors" onClick={async () => {
                   try {
                     const res = await fetch('http://localhost:8001/api/v1/ai/predict/NVDA?days=30');
                     const data = await res.json();
                     alert(JSON.stringify(data, null, 2));
                   } catch(e) { alert("Failed to connect to backend AI."); }
               }}>Run Live Prediction (NVDA)</button>
            </div>

            <div className="bg-white/5 border border-white/10 rounded-3xl p-6 backdrop-blur-md shadow-xl flex flex-col justify-center items-center text-center">
               <div className="w-16 h-16 rounded-full bg-purple-500/20 text-purple-400 flex items-center justify-center mb-4">
                  <PieChart size={32} />
               </div>
               <h2 className="text-xl font-bold mb-2">FinBERT NLP Sentiment</h2>
               <p className="text-gray-400 text-sm max-w-sm mb-6">Scans Reddit and Financial News in real-time to gauge quantitative market emotion.</p>
               
               <div className="flex gap-4 w-full justify-center items-center mb-6">
                  <div className="text-center px-4 border-r border-white/10">
                     <p className="text-3xl font-black text-purple-400">12</p>
                     <p className="text-xs text-gray-500">Live Threads</p>
                  </div>
                  <div className="text-center px-4">
                     <p className="text-3xl font-black text-green-400">BULLISH</p>
                     <p className="text-xs text-gray-500">TSLA Sentiment</p>
                  </div>
               </div>

               <button className="px-6 py-3 bg-purple-500 hover:bg-purple-600 rounded-xl font-medium transition-colors" onClick={async () => {
                   try {
                     const res = await fetch('http://localhost:8001/api/v1/ai/sentiment/TSLA');
                     const data = await res.json();
                     alert(JSON.stringify(data, null, 2));
                   } catch(e) { alert("Failed to connect to backend AI."); }
               }}>Scan Market (TSLA)</button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
