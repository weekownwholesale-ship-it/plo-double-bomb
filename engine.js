// engine.js — Double-board bomb pot PLO sparring engine.
// Hero (seat 0) vs 8 equity-driven bots. 9-handed, 100bb, 5bb ante (bomb pot).
// Two boards, each worth half the pot. Pot-limit flop/turn/river. No preflop action.
// Requires core.js (globals in browser, require in node).
'use strict';
const CORE = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : window;

const N = 9, ANTE = 5, START_STACK = 100;

function posName(p){ return ['BTN','SB','BB','UTG','UTG+1','MP1','MP2','HJ','CO'][p]; }

class Game {
  constructor(cb){
    this.cb = cb || {feed(){}, update(){}, heroTurn(){}, showdown(){}};
    this.button = (Math.random()*N)|0;
    this.stacks = new Array(N).fill(START_STACK);
    this.sessHands = 0; this.sessNet = 0; this.sessGrades = [];
    try {
      const s = JSON.parse(localStorage.getItem('dbomb_sess')||'null');
      if(s){ this.sessHands=s.h||0; this.sessNet=s.n||0; this.sessGrades=s.g||[]; }
    } catch(e){}
  }
  saveSess(){
    try{ localStorage.setItem('dbomb_sess', JSON.stringify({h:this.sessHands,n:this.sessNet,g:this.sessGrades})); }catch(e){}
  }

  startHand(){
    this.button = (this.button+1)%N;
    this.handNum = (this.handNum||0)+1;
    for(let i=0;i<N;i++) if(this.stacks[i] < 1){ this.stacks[i]=START_STACK; }
    this.pot = 0; this.board1 = []; this.board2 = [];
    this.street = 0; this.handDone = false; this.awaitingHero = false;
    this.handBet = new Array(N).fill(0);
    this.folded = new Array(N).fill(false);
    this.allin = new Array(N).fill(false);
    this.streetBets = new Array(N).fill(0);
    this.acted = new Array(N).fill(false);
    // bomb pot ante: everyone posts
    for(let s=0;s<N;s++){
      const a = Math.min(ANTE, this.stacks[s]);
      this.stacks[s]-=a; this.handBet[s]+=a; this.pot+=a;
    }
    // deal
    const deck = CORE.shuffle(CORE.fullDeck());
    this.hole = [];
    for(let s=0;s<N;s++){ this.hole.push([deck.pop(),deck.pop(),deck.pop(),deck.pop()]); }
    this.board1 = [deck.pop(),deck.pop(),deck.pop()];
    this.board2 = [deck.pop(),deck.pop(),deck.pop()];
    this.deck = deck;
    this.street = 3; // flop
    this.acting = (this.button+1)%N; // UTG-ish, action starts left of button
    // precompute hero combined equity for grading baseline
    this.cb.feed(`<b>Hand ${this.handNum}</b> — double-board bomb pot, ${ANTE}bb ante each, ${(N*ANTE).toFixed(0)}bb in the middle.`);
    this.cb.update();
  }

  // Combined equity across both boards vs nOpp random opponents.
  // Proper Monte Carlo: completes both boards to 5 cards each iteration.
  combinedEquity(hand, b1, b2, nOpp, iters){
    let score=0;
    const deck = CORE.fullDeck();
    const used = new Set();
    hand.forEach(c=>used.add(c.r*4+c.s));
    b1.forEach(c=>used.add(c.r*4+c.s));
    b2.forEach(c=>used.add(c.r*4+c.s));
    const base = deck.filter(c=>!used.has(c.r*4+c.s));
    const need1 = 5-b1.length, need2 = 5-b2.length;
    for(let i=0;i<iters;i++){
      const d = CORE.shuffle(base.slice());
      let idx=0;
      const opps=[];
      for(let p=0;p<nOpp;p++){ opps.push([d[idx++],d[idx++],d[idx++],d[idx++]]); }
      const cb1=b1.slice(), cb2=b2.slice();
      for(let k=0;k<need1;k++) cb1.push(d[idx++]);
      for(let k=0;k<need2;k++) cb2.push(d[idx++]);
      const hb1=CORE.ploBest(hand,cb1), hb2=CORE.ploBest(hand,cb2);
      let s1=1, s2=1;
      for(const oh of opps){
        const ob1=CORE.ploBest(oh,cb1), ob2=CORE.ploBest(oh,cb2);
        if(CORE.cmp5(ob1,hb1)>0) s1=0; else if(CORE.cmp5(ob1,hb1)===0) s1=Math.min(s1,0.5);
        if(CORE.cmp5(ob2,hb2)>0) s2=0; else if(CORE.cmp5(ob2,hb2)===0) s2=Math.min(s2,0.5);
      }
      score += (s1+s2)/2;
    }
    return score/iters;
  }

  liveOpp(){
    let n=0;
    for(let s=0;s<N;s++) if(!this.folded[s] && s!==0) n++;
    return n;
  }

  maxBet(){
    return Math.max(...this.handBet);
  }

  toCall(seat){
    return this.maxBet()-this.handBet[seat];
  }

  potAfter(){
    return this.pot;
  }

  // max pot-limit raise total for seat
  potLimitTotal(seat){
    const tc = this.toCall(seat);
    // pot after calling = pot + tc; max raise = tc + (pot + tc) = pot + 2*tc... 
    // standard: max total = current bet level + (pot after call)
    const potAfterCall = this.pot + tc;
    let maxTotal = this.maxBet() + potAfterCall;
    // can't exceed stack
    maxTotal = Math.min(maxTotal, this.handBet[seat] + this.stacks[seat]);
    return maxTotal;
  }

  minRaiseTotal(seat){
    // min raise = 2x the current max bet level (or all-in)
    const mb = this.maxBet();
    const cur = this.handBet[seat];
    let minTotal;
    if(mb === cur){
      // opening: min bet = 1bb? use 1bb min
      minTotal = cur + 1;
    } else {
      const lastRaise = mb - cur; // amount to call
      // min re-raise: at least double the previous total bet
      minTotal = mb + Math.max(lastRaise, 1);
    }
    return Math.min(minTotal, cur + this.stacks[seat]);
  }

  botAct(seat){
    const nOpp = this.liveOpp() - 0 + (this.folded[0]?0:1); // opponents of this bot
    // count live opponents excluding this bot
    let foes = 0;
    for(let s=0;s<N;s++) if(s!==seat && !this.folded[s]) foes++;
    const b1 = this.board1, b2 = this.board2;
    const streetCards = this.street; // 3,4,5
    const iters = streetCards===3 ? 40 : 60;
    const eq = this.combinedEquity(this.hole[seat], b1, b2, foes, iters);
    const tc = this.toCall(seat);
    const pot = this.pot;
    const stack = this.stacks[seat];

    // pot odds
    if(tc > 0){
      const need = tc/(pot+tc);
      // honest: call if equity > needed (with small margin), else fold
      // add slight looseness multiway
      const margin = foes>=3 ? 0.92 : 0.97;
      if(eq > need*margin && tc < stack){
        // consider raising if very strong
        if(eq > 0.62 && Math.random()<0.5){
          return this._botRaise(seat, eq);
        }
        return {t:'call'};
      } else {
        // occasional bluff-raise if checked to and equity decent? keep honest: fold
        return {t:'fold'};
      }
    } else {
      // checked to: bet if equity good
      if(eq > 0.55){
        return this._botBet(seat, eq);
      }
      // sometimes stab
      if(eq > 0.42 && Math.random()<0.25){
        return this._botBet(seat, eq);
      }
      return {t:'check'};
    }
  }

  _botBet(seat, eq){
    const pot = this.pot;
    const maxT = this.potLimitTotal(seat);
    const cur = this.handBet[seat];
    // size: 0.5-1.0 pot based on equity
    const frac = 0.5 + Math.min(0.5, (eq-0.5));
    let total = cur + Math.max(1, pot*frac);
    total = Math.min(total, maxT);
    total = Math.min(total, cur + this.stacks[seat]);
    if(total <= cur) return {t:'check'};
    return {t:'bet', total: Math.round(total*2)/2};
  }

  _botRaise(seat, eq){
    const cur = this.handBet[seat];
    const maxT = this.potLimitTotal(seat);
    const minT = this.minRaiseTotal(seat);
    if(maxT <= this.maxBet()) return {t:'call'};
    // pot-sized raise
    let total = maxT;
    if(eq < 0.7){
      // smaller raise
      total = Math.min(maxT, this.maxBet() + (this.pot*0.75));
      total = Math.max(total, minT);
    }
    total = Math.min(total, cur + this.stacks[seat]);
    total = Math.round(total*2)/2;
    if(total <= this.maxBet()) return {t:'call'};
    return {t:'raise', total};
  }

  applyAction(seat, a){
    // a: {t:'fold'|'check'|'call'|'bet'|'raise', total}
    const cur = this.handBet[seat];
    if(a.t==='fold'){
      this.folded[seat]=true;
      this.cb.feed(`${this._nm(seat)} folds.`);
    } else if(a.t==='check'){
      this.cb.feed(`${this._nm(seat)} checks.`);
    } else if(a.t==='call'){
      const tc = this.toCall(seat);
      const amt = Math.min(tc, this.stacks[seat]);
      this.stacks[seat]-=amt; this.handBet[seat]+=amt; this.pot+=amt;
      if(this.stacks[seat]<=0.001) this.allin[seat]=true;
      this.cb.feed(`${this._nm(seat)} calls ${amt.toFixed(1)}.`);
    } else if(a.t==='bet' || a.t==='raise'){
      const total = Math.min(a.total, cur + this.stacks[seat]);
      const amt = total - cur;
      this.stacks[seat]-=amt; this.handBet[seat]=total; this.pot+=amt;
      if(this.stacks[seat]<=0.001) this.allin[seat]=true;
      // reset acted for others
      for(let s=0;s<N;s++) if(s!==seat && !this.folded[s] && !this.allin[s]) this.acted[s]=false;
      this.cb.feed(`${this._nm(seat)} ${a.t==='bet'?'bets':'raises to'} ${total.toFixed(1)}.`);
    }
    this.acted[seat]=true;
    this.cb.update();
  }

  _nm(seat){
    if(seat===0) return '<b>Hero</b>';
    return 'P'+seat+'('+posName((this.button+seat)%N)+')';
  }

  _streetDone(){
    // all live non-allin players have acted and bets are equal
    const mb = this.maxBet();
    for(let s=0;s<N;s++){
      if(this.folded[s]||this.allin[s]) continue;
      if(!this.acted[s]) return false;
      if(Math.abs(this.handBet[s]-mb)>0.001 && this.stacks[s]>0.001) return false;
    }
    return true;
  }

  _liveCount(){
    let n=0;
    for(let s=0;s<N;s++) if(!this.folded[s]) n++;
    return n;
  }

  step(){
    if(this.handDone) return {t:'end'};
    if(this.awaitingHero){
      return {t:'hero'};
    }
    // check if hand over by folds
    if(this._liveCount()===1){
      return this._endHand();
    }
    if(this._streetDone()){
      return this._nextStreet();
    }
    const s = this.acting;
    // skip folded/allin
    if(this.folded[s]||this.allin[s]||this.acted[s]){
      this.acting=(this.acting+1)%N;
      return {t:'bot'};
    }
    if(s===0){
      this.awaitingHero=true;
      const acts = this._heroActions();
      this.cb.heroTurn(acts);
      return {t:'hero'};
    }
    const a = this.botAct(s);
    // grade bots? no, just apply
    this.applyAction(s, a);
    this.acting=(this.acting+1)%N;
    return {t:'bot'};
  }

  _heroActions(){
    const tc = this.toCall(0);
    const stack = this.stacks[0];
    const cur = this.handBet[0];
    const maxT = this.potLimitTotal(0);
    const minT = this.minRaiseTotal(0);
    const acts = [];
    if(tc>0.001){
      const callAmt = Math.min(tc, stack);
      // estimate equity for display
      acts.push({t:'fold', label:'Fold'});
      acts.push({t:'call', label:`Call ${callAmt.toFixed(1)}`, amt:callAmt});
      if(maxT > this.maxBet()+0.001 && stack > tc+0.001){
        acts.push({t:'raise', label:`Raise (pot max ${maxT.toFixed(1)})`, maxTotal:maxT, minTotal:minT});
      }
    } else {
      acts.push({t:'check', label:'Check'});
      if(maxT > cur+0.001 && stack>0.001){
        acts.push({t:'bet', label:`Bet (pot max ${(cur+Math.min(maxT-cur, stack)).toFixed(1)})`, maxTotal:maxT, minTotal:cur+1});
      }
    }
    // all-in always available if stack>0
    return acts;
  }

  heroDo(a){
    // a: {t, amt?, total?}
    this.awaitingHero=false;
    const grade = this._gradeHero(a);
    this.sessGrades.push(grade.g);
    if(grade.g!=='A'){
      this.cb.feed(`<span class="grade ${grade.g}">[${grade.g}]</span> ${grade.note} <i>(cost ~${grade.cost.toFixed(1)}bb)</i>`);
    } else {
      this.cb.feed(`<span class="grade A">[A]</span> ${grade.note}`);
    }
    this.applyAction(0, a);
    this.acting=1%N;
    // continue pump via cb
  }

  _gradeHero(a){
    // Estimate combined equity vs live opponents
    let foes=0;
    for(let s=1;s<N;s++) if(!this.folded[s]) foes++;
    const eq = this.combinedEquity(this.hole[0], this.board1, this.board2, Math.max(foes,1), 80);
    const tc = this.toCall(0);
    const pot = this.pot;
    const evFold = 0;
    const evCall = tc>0.001 ? eq*(pot+tc)-Math.min(tc,this.stacks[0]) : 0;
    // best of fold/call as baseline
    const bestSimple = Math.max(evFold, evCall);
    let g, note, cost=0;
    const eqPct = (eq*100).toFixed(1);
    if(a.t==='fold'){
      if(evCall > 1.0){
        // folding a +EV call
        cost = evCall;
        g = cost>pot*0.15?'F':(cost>pot*0.08?'D':'C');
        note = `Folded with ${eqPct}% combined equity getting ${(tc/(pot+tc)*100).toFixed(0)}% pot odds.`;
      } else {
        g='A'; note=`Good fold — ${eqPct}% combined equity.`;
      }
    } else if(a.t==='call'){
      if(evCall < -1.0){
        cost = -evCall;
        g = cost>pot*0.15?'F':(cost>pot*0.08?'D':'C');
        note = `Called with ${eqPct}% combined equity needing ${(tc/(pot+tc)*100).toFixed(0)}%.`;
      } else {
        g = evCall>bestSimple-0.5?'A':'B'; note=`Call fine — ${eqPct}% combined equity.`;
      }
    } else if(a.t==='check'){
      // check is fine unless a bet was clearly +EV; keep simple
      g='A'; note=`Check — ${eqPct}% combined equity.`;
    } else if(a.t==='bet'||a.t==='raise'){
      const total = a.total;
      const amt = total - this.handBet[0];
      if(eq < 0.35 && tc>0.001){
        // bluffing into strength; simplified
        g='C'; cost=amt*0.3; note=`Aggressive with ${eqPct}% combined equity — thin.`;
      } else if(eq > 0.55){
        g='A'; note=`Value ${a.t} with ${eqPct}% combined equity.`;
      } else {
        g='B'; note=`${a.t==='bet'?'Bet':'Raise'} with ${eqPct}% combined equity.`;
      }
    }
    return {g, note, cost};
  }

  _nextStreet(){
    if(this.street>=5){
      return this._endHand();
    }
    this.street++;
    const c1 = this.deck.pop(), c2 = this.deck.pop();
    if(this.street===4){ this.board1.push(c1); this.board2.push(c2); this.cb.feed(`<b>Turn:</b> ${this._cs(c1)} / ${this._cs(c2)}`); }
    else { this.board1.push(c1); this.board2.push(c2); this.cb.feed(`<b>River:</b> ${this._cs(c1)} / ${this._cs(c2)}`); }
    this.acted = new Array(N).fill(false);
    this.acting = (this.button+1)%N;
    this.cb.update();
    return {t:'street'};
  }

  _cs(c){
    const R='23456789TJQKA', S=['♠','♥','♦','♣'];
    const col = (c.s===1||c.s===2)?'red':'';
    return `<span class="card ${col}">${R[c.r]}${S[c.s]}</span>`;
  }

  _endHand(){
    this.handDone=true;
    // find winners per board
    const live=[];
    for(let s=0;s<N;s++) if(!this.folded[s]) live.push(s);
    let win1=[], win2=[], best1=null, best2=null;
    if(live.length===1){
      win1=live; win2=live;
    } else {
      for(const s of live){
        const h1=CORE.ploBest(this.hole[s], this.board1);
        const h2=CORE.ploBest(this.hole[s], this.board2);
        if(!best1 || CORE.cmp5(h1,best1)>0){ best1=h1; win1=[s]; }
        else if(CORE.cmp5(h1,best1)===0){ win1.push(s); }
        if(!best2 || CORE.cmp5(h2,best2)>0){ best2=h2; win2=[s]; }
        else if(CORE.cmp5(h2,best2)===0){ win2.push(s); }
      }
    }
    const half = this.pot/2;
    const share1 = half/win1.length, share2 = half/win2.length;
    for(const s of win1){ this.stacks[s]+=share1; }
    for(const s of win2){ this.stacks[s]+=share2; }
    this.pot = 0;
    // session accounting for hero
    const heroWon = (win1.includes(0)?share1:0)+(win2.includes(0)?share2:0);
    const heroInvested = this.handBet[0];
    const net = heroWon - heroInvested;
    this.sessNet += net;
    this.sessHands++;
    this.saveSess();
    const nm = s=>s===0?'<b>Hero</b>':('P'+s);
    this.cb.feed(`<b>Showdown.</b> Top: ${win1.map(nm).join(', ')} win ${share1.toFixed(1)} | Bot: ${win2.map(nm).join(', ')} win ${share2.toFixed(1)}. Hero ${net>=0?'+':''}${net.toFixed(1)}bb.`);
    this.cb.showdown({win1, win2, share1, share2, net});
    this.cb.update();
    return {t:'end'};
  }
}

if(typeof module!=='undefined'){
  module.exports={Game, posName, ANTE, N, START_STACK};
} else {
  window.DBGame=Game; window.dbPosName=posName;
}
