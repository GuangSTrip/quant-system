"use strict";

const state = { data: null, token: null, chart: "equity" };
const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });
const money = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const compactMoney = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

function pct(value) { return Number.isFinite(Number(value)) ? (Number(value) * 100).toFixed(2) + "%" : "—"; }
function ratio(value) { return Number.isFinite(Number(value)) ? Number(value).toFixed(2) : "—"; }
function day(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? String(value).slice(0, 10) : d.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
}
function time(value) {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? value : d.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}
function setText(id, value) { $(id).textContent = value; }
function escapeText(value) { const span = document.createElement("span"); span.textContent = String(value || ""); return span.innerHTML; }
function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  window.setTimeout(() => el.classList.remove("show"), 2400);
}

async function load() {
  $("refresh").disabled = true;
  try {
    const response = await fetch("/api/snapshot", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取本地报告");
    state.data = await response.json();
    state.token = state.data.action_token;
    render();
  } catch (error) {
    toast(error.message);
  } finally {
    $("refresh").disabled = false;
  }
}

function render() {
  const d = state.data;
  const m = d.metrics || {};
  const curve = d.curve || [];
  const last = curve.length ? curve[curve.length - 1] : null;
  setText("report-name", d.report.available ? d.report.name : d.report.name + "（无报告）");
  setText("report-range", d.report.data_start && d.report.data_end ? day(d.report.data_start) + " — " + day(d.report.data_end) : "等待回测数据");
  setText("updated-at", time(d.generated_at));
  setText("equity", last ? money.format(last.equity) : "—");
  setText("total-return", pct(m.total_return));
  $("total-return").classList.toggle("negative", Number(m.total_return) < 0);
  setText("cagr", pct(m.cagr));
  setText("benchmark-cagr", pct(m.benchmark_cagr));
  setText("sharpe", ratio(m.sharpe_ratio));
  setText("sortino", ratio(m.sortino_ratio));
  setText("max-drawdown", pct(m.max_drawdown));
  setText("calmar", ratio(m.calmar_ratio));
  renderChart();
  renderPositions(d.positions || []);
  renderTrades(d.trades || []);
  renderAudit(d.audit || []);
  renderSafety(d.safety);
}

function svgNode(name, attrs) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attrs).forEach((entry) => node.setAttribute(entry[0], entry[1]));
  return node;
}
function pathFor(values, min, max) {
  const w = 900, h = 300, pad = 8, span = Math.max(max - min, 1e-9);
  return values.map((value, i) => (i ? "L" : "M") + (i / Math.max(values.length - 1, 1) * w).toFixed(2) + "," + (pad + (max - value) / span * (h - pad * 2)).toFixed(2)).join(" ");
}
function renderChart() {
  const svg = $("main-chart");
  svg.replaceChildren();
  const curve = state.data.curve || [];
  $("chart-empty").hidden = curve.length > 0;
  if (!curve.length) {
    setText("chart-start", "—");
    setText("chart-end", "—");
    return;
  }
  for (let i = 0; i <= 4; i++) svg.append(svgNode("line", { x1: 0, y1: 8 + i * 71, x2: 900, y2: 8 + i * 71, stroke: "#182230", "stroke-width": 1 }));
  const drawdown = state.chart === "drawdown";
  const primary = curve.map((row) => drawdown ? row.drawdown : row.equity);
  const secondary = drawdown ? [] : curve.map((row) => row.benchmark).filter(Number.isFinite);
  const all = primary.concat(secondary);
  let min = Math.min.apply(null, all), max = Math.max.apply(null, all);
  const padding = (max - min) * 0.08 || 1;
  min -= padding;
  max += padding;
  if (!drawdown && secondary.length === primary.length) {
    svg.append(svgNode("path", { d: pathFor(secondary, min, max), fill: "none", stroke: "#536c91", "stroke-width": 2, "stroke-dasharray": "5 5", "vector-effect": "non-scaling-stroke" }));
  }
  const area = pathFor(primary, min, max) + " L900,300 L0,300 Z";
  svg.append(svgNode("path", { d: area, fill: drawdown ? "rgba(255,94,109,.07)" : "rgba(109,232,209,.07)" }));
  svg.append(svgNode("path", { d: pathFor(primary, min, max), fill: "none", stroke: drawdown ? "#ff6977" : "#6de8d1", "stroke-width": 2.3, "vector-effect": "non-scaling-stroke" }));
  $("legend").style.visibility = drawdown ? "hidden" : "visible";
  svg.setAttribute("aria-label", drawdown ? "组合回撤曲线" : "策略净值与基准曲线");
  setText("chart-start", day(curve[0].timestamp));
  setText("chart-end", day(curve[curve.length - 1].timestamp));
}

function renderPositions(rows) {
  const body = $("positions-body");
  body.replaceChildren();
  setText("position-count", rows.length + " 项");
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">当前报告没有期末持仓</td></tr>';
    return;
  }
  rows.slice(0, 12).forEach((row) => {
    const tr = document.createElement("tr");
    const width = Math.min(Math.abs(row.weight) * 100, 100);
    tr.innerHTML = "<td>" + escapeText(row.symbol) + '</td><td><div class="weight-cell"><span>' + pct(row.weight) + '</span><span class="weight-bar"><i style="width:' + width + '%"></i></span></div></td><td>' + number.format(row.quantity) + "</td><td>" + compactMoney.format(row.market_value) + "</td>";
    body.append(tr);
  });
}
function renderTrades(rows) {
  const body = $("trades-body");
  body.replaceChildren();
  setText("trade-count", rows.length + " 笔");
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">当前报告没有成交记录</td></tr>';
    return;
  }
  rows.forEach((row) => {
    const side = String(row.side).toUpperCase();
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + day(row.timestamp) + "</td><td>" + escapeText(row.symbol) + '<\/td><td class="' + (side === "BUY" ? "side-buy" : "side-sell") + '">' + (side === "BUY" ? "买入" : "卖出") + "</td><td>" + number.format(row.quantity) + "</td><td>" + money.format(row.price) + "</td><td>" + compactMoney.format(row.notional) + "</td><td>" + pct(row.fill_ratio) + "</td>";
    body.append(tr);
  });
}
function renderAudit(rows) {
  const list = $("activity-list");
  list.replaceChildren();
  if (!rows.length) {
    list.innerHTML = '<li class="activity-empty">尚无模拟盘审计事件。安全控制操作会记录在这里。</li>';
    return;
  }
  rows.slice(0, 8).forEach((row) => {
    const li = document.createElement("li");
    li.innerHTML = '<div class="activity-title">' + escapeText(row.summary) + '</div><div class="activity-time">' + time(row.timestamp) + "</div>";
    list.append(li);
  });
}
function renderSafety(safety) {
  const halted = Boolean(safety.kill_switch_active);
  const panel = document.querySelector(".safety-panel");
  panel.classList.toggle("halted", halted);
  const badge = $("safety-state");
  badge.classList.toggle("halted", halted);
  badge.textContent = halted ? "HALT 已启用" : "边界正常";
  setText("safety-symbol", halted ? "Ⅱ" : "✓");
  setText("safety-copy", halted ? "本机模拟盘已暂停。任何提交尝试都应被拒绝。" : "系统仅展示本地报告；网页端不具备任何订单提交能力。");
  const button = $("toggle-halt");
  button.disabled = false;
  button.classList.toggle("resume", halted);
  button.textContent = halted ? "恢复模拟盘" : "立即暂停模拟盘";
  button.dataset.halted = halted ? "true" : "false";
}

async function setHalt(halted, confirmation) {
  const response = await fetch(halted ? "/api/safety/halt" : "/api/safety/resume", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Dashboard-Token": state.token },
    body: JSON.stringify({ confirmation: confirmation || "" })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "安全状态更新失败");
  await load();
  toast(halted ? "模拟盘已暂停" : "模拟盘已恢复");
}

$("refresh").addEventListener("click", load);
document.querySelectorAll(".chart-tab").forEach((tab) => tab.addEventListener("click", () => {
  state.chart = tab.dataset.chart;
  document.querySelectorAll(".chart-tab").forEach((item) => {
    const active = item === tab;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
  });
  renderChart();
}));
$("toggle-halt").addEventListener("click", async () => {
  if ($("toggle-halt").dataset.halted === "true") {
    $("resume-confirmation").value = "";
    $("resume-dialog").showModal();
  } else {
    try { await setHalt(true); } catch (error) { toast(error.message); }
  }
});
$("confirm-resume").addEventListener("click", async (event) => {
  event.preventDefault();
  const value = $("resume-confirmation").value;
  if (value !== "恢复模拟盘") {
    toast("请输入完整确认文本");
    return;
  }
  $("resume-dialog").close();
  try { await setHalt(false, value); } catch (error) { toast(error.message); }
});

load();
