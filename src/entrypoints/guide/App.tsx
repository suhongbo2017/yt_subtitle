import { useCallback, useEffect, useState } from 'react';
import { browser } from 'wxt/browser';
import { settingsItem } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

const GH_EXT = 'https://github.com/suhongbo2017/yt_subtitle';
const GH_PDF = 'https://github.com/suhongbo2017/pdf_trasllama';

interface Stats {
  trCacheEntries: number;
  trCacheBytes: number;
  provider: string;
  targetLang: string;
  visionUrl: string;
  asrUrl: string;
}

type Svc = { online: boolean; detail?: string };

const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function Badge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
        ok ? 'bg-emerald-500/15 text-emerald-400' : 'bg-neutral-800 text-neutral-500'
      }`}
    >
      {children}
    </span>
  );
}

function Card({
  title,
  desc,
  ready,
  readyText,
  needText,
  action,
  actionText,
}: {
  title: string;
  desc: string;
  ready: boolean;
  readyText: string;
  needText?: string;
  action?: () => void;
  actionText?: string;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-neutral-800 bg-neutral-900/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold text-neutral-100">{title}</h3>
        <Badge ok={ready}>{ready ? readyText : needText ?? '未就绪'}</Badge>
      </div>
      <p className="flex-1 text-[11px] leading-relaxed text-neutral-500">{desc}</p>
      {action && (
        <button
          type="button"
          onClick={action}
          className="rounded-lg bg-neutral-800 py-1.5 text-[11px] font-medium text-neutral-200 transition hover:bg-neutral-700"
        >
          {actionText}
        </button>
      )}
    </div>
  );
}

function Section({ title, children, hint }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-baseline gap-2">
        <h2 className="text-sm font-semibold text-neutral-300">{title}</h2>
        {hint && <span className="text-[11px] text-neutral-600">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

const FAQ: Array<[string, string]> = [
  ['完全没有字幕出现', '先看视频右下角 CC 是否开启；再确认是不是扩展刚更新过（刷新页面）。如果视频本身没有字幕轨，用「语音识别」生成。'],
  ['字幕只有中文，没有原文', '弹窗里「显示原文」被关了。'],
  ['字幕和 YouTube 原生字幕重叠', '弹窗里打开「隐藏原生字幕」。'],
  ['字幕中间有空白段', '这段是音乐/静音，YouTube 字幕轨本身没内容；或用了实时识别模式。'],
  ['点「语音识别」没反应', '看顶部 ASR 徽章是否为灰（服务未启动）。双击 install-native-host.cmd 装一次，之后在弹窗里开关。'],
  ['生成字幕一直卡在 downloading', '多半是 yt-dlp 被 YouTube 判定为机器人（出口 IP 或 cookie 过期）。可点「改用实时识别」兜底。'],
  ['提示「没有识别到语音」', '这段音频确实没人声（纯音乐/音量过低），或演唱类视频。可换 small 模型再试。'],
  ['整页翻译很慢或翻到一半停了', 'Google 免费接口对长页面容易限流，会自动停下。建议在设置页切到 LLM 引擎。'],
  ['截图翻译点完没反应', '看屏幕右下角的系统通知（弹窗已关闭，错误只走通知）。通常是视觉服务没启动。'],
  ['视觉徽章一直是灰的', '截图翻译由独立项目 pdf_trasllama 提供，需要在那边的目录双击 start-server.cmd。'],
];

export default function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<Stats | null>(null);
  const [asr, setAsr] = useState<Svc>({ online: false });
  const [vision, setVision] = useState<Svc>({ online: false });
  const [busy, setBusy] = useState('');
  const [toast, setToast] = useState('');
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  };

  const loadStats = useCallback(async () => {
    const res = (await browser.runtime.sendMessage({ type: 'ytsub:cache-stats' })) as
      | { ok: boolean; stats?: Stats }
      | undefined;
    if (res?.ok && res.stats) setStats(res.stats);
  }, []);

  useEffect(() => {
    void settingsItem.getValue().then((s) => setSettings({ ...DEFAULT_SETTINGS, ...(s ?? {}) }));
    void loadStats();
  }, [loadStats]);

  // 两个服务的在线探测
  useEffect(() => {
    let alive = true;
    const ping = async () => {
      const [asrRes, visRes] = await Promise.all([
        fetch(`${settings.asrUrl.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.json())
          .catch(() => null),
        fetch(`${settings.visionUrl.replace(/\/+$/, '')}/api/config`, { signal: AbortSignal.timeout(1500) })
          .then((r) => r.json())
          .catch(() => null),
      ]);
      if (!alive) return;
      setAsr({ online: !!asrRes?.ok, detail: asrRes?.model });
      setVision({ online: !!visRes?.ok, detail: visRes?.default });
    };
    void ping();
    const timer = setInterval(ping, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [settings.asrUrl, settings.visionUrl]);

  const toggleAsrService = async (start: boolean) => {
    setBusy('asr');
    try {
      const res = (await browser.runtime.sendMessage({ type: 'ytsub:service', cmd: start ? 'start' : 'stop' })) as
        | { ok: boolean; error?: string; result?: { ok?: boolean; error?: string } }
        | undefined;
      if (!res?.ok) throw new Error(res?.error ?? '调用启动器失败');
      if (res.result && res.result.ok === false) throw new Error(res.result.error ?? '启动失败');
      flash(start ? 'ASR 服务已启动' : 'ASR 服务已停止');
    } catch (err) {
      flash(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('');
    }
  };

  const openVideoTab = async () => {
    await browser.tabs.create({ url: 'https://www.youtube.com/' });
  };

  const clearCache = async () => {
    setBusy('cache');
    try {
      await browser.runtime.sendMessage({ type: 'ytsub:cache-clear', what: 'trcache' });
      await loadStats();
      flash('翻译缓存已清空');
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-8 px-6 py-10">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex-1">
          <h1 className="text-xl font-semibold tracking-tight">使用说明 · 控制台</h1>
          <p className="mt-1 text-sm text-neutral-500">
            YouTube 双语字幕 · 整页翻译 · 语音识别 · 截图翻译
          </p>
        </div>
        <Badge ok={asr.online}>ASR {asr.online ? asr.detail ?? '' : '离线'}</Badge>
        <Badge ok={vision.online}>视觉 {vision.online ? vision.detail ?? '' : '离线'}</Badge>
        <button
          type="button"
          onClick={() => void browser.runtime.openOptionsPage()}
          className="rounded-lg bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:bg-neutral-700"
        >
          打开设置
        </button>
      </header>

      <Section title="功能" hint="点按钮立刻用；灰掉的看右侧说明">
        <div className="grid gap-3 sm:grid-cols-2">
          <Card
            title="在线字幕翻译"
            desc="打开 YouTube 视频自动叠加中英字幕（用 YouTube 自带字幕轨，含自动字幕）。无需任何服务。"
            ready
            readyText="随时可用"
            action={() => void openVideoTab()}
            actionText="打开 YouTube"
          />
          <Card
            title="点播字幕生成"
            desc="视频没有字幕轨时，后台下载音频并整段转写。首次 1–3 分钟，之后同一视频秒开且可任意拖动。"
            ready={asr.online}
            readyText="服务在线"
            needText="需启动 ASR"
            action={() => void toggleAsrService(!asr.online)}
            actionText={busy === 'asr' ? '处理中…' : asr.online ? '停止 ASR 服务' : '启动 ASR 服务'}
          />
          <Card
            title="整页翻译"
            desc="把当前网页正文原地翻成中文，右下角面板可随时恢复原文。只翻正文容器，跳过导航/代码/已是中文。"
            ready={settings.enabled}
            readyText="随时可用"
            needText="翻译已关闭"
            action={async () => {
              const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
              if (!/^https?:/i.test(tab?.url ?? '')) {
                flash('当前标签页不支持注入（需要 http/https 网页）');
                return;
              }
              await browser.scripting.executeScript({
                target: { tabId: tab!.id! },
                files: ['/content-scripts/page-tr.js'],
              });
              flash('已开始翻译；再点一次弹窗按钮可恢复原文');
            }}
            actionText="翻译当前标签页"
          />
          <Card
            title="截图翻译"
            desc="框选屏幕区域 → 识别外文 → 新标签页按原位置叠加译文。识别由独立项目 pdf_trasllama 提供。"
            ready={vision.online}
            readyText="服务在线"
            needText="需启动视觉服务"
            action={() => flash(`在 pdf_trasllama 目录双击 start-server.cmd（${settings.visionUrl}）`)}
            actionText="怎么启动视觉服务"
          />
          <Card
            title="文档翻译"
            desc="扫描件/图片 PDF → 双语 PDF / 覆盖式 HTML / Markdown。在视觉服务的网页界面里操作。"
            ready={vision.online}
            readyText="服务在线"
            needText="需启动视觉服务"
            action={() => void browser.tabs.create({ url: settings.visionUrl })}
            actionText="打开文档翻译界面"
          />
          <Card
            title="翻译引擎"
            desc={
              settings.provider === 'google'
                ? '当前 Google 免费：零配置、直译。长页面/整页翻译建议切 LLM（更快更自然）。'
                : `当前 LLM：${settings.apiModel || '已配置'}。质量更好，整页翻译也快得多。`
            }
            ready
            readyText={settings.provider === 'google' ? 'Google 免费' : 'LLM'}
            action={() => void browser.runtime.openOptionsPage()}
            actionText="切换引擎"
          />
        </div>
      </Section>

      <Section title="快速上手">
        <ol className="space-y-2 rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-[12px] leading-relaxed text-neutral-400">
          <li>
            <b className="text-neutral-200">1. 看视频</b> —— 打开任意 YouTube 视频，字幕自动出现。没有字幕？
            点扩展图标开「语音识别」。
          </li>
          <li>
            <b className="text-neutral-200">2. 看网页</b> —— 点扩展图标 → 「🌐 翻译此页面」。恢复原文点页面右下角按钮。
          </li>
          <li>
            <b className="text-neutral-200">3. 看截图/文档</b> —— 截图翻译用弹窗里的「📝 截图翻译」框选；
            文档翻译去视觉服务的网页界面拖 PDF。
          </li>
          <li>
            <b className="text-neutral-200">4. 出问题</b> —— 弹窗底部「运行状态」会写清楚在跑哪个功能、错误是什么；
            本页下面的常见问题也能对号入座。
          </li>
        </ol>
      </Section>

      <Section title="数据管理" hint="缓存只在本机">
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-[12px]">
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-neutral-500 sm:grid-cols-4">
            <span>翻译缓存</span>
            <span className="text-neutral-300">{stats ? `${stats.trCacheEntries} 条 · ${kb(stats.trCacheBytes)}` : '—'}</span>
            <span>当前目标语言</span>
            <span className="text-neutral-300">{stats?.targetLang ?? settings.targetLang}</span>
            <span>ASR 服务</span>
            <span className="truncate text-neutral-300">{settings.asrUrl}</span>
            <span>视觉服务</span>
            <span className="truncate text-neutral-300">{settings.visionUrl}</span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void loadStats()}
              className="rounded-lg bg-neutral-800 px-3 py-1.5 text-[11px] text-neutral-300 hover:bg-neutral-700"
            >
              刷新统计
            </button>
            <button
              type="button"
              disabled={busy === 'cache' || !stats?.trCacheEntries}
              onClick={() => void clearCache()}
              className="rounded-lg bg-rose-900/40 px-3 py-1.5 text-[11px] text-rose-300 hover:bg-rose-900/60 disabled:opacity-40"
            >
              清空翻译缓存
            </button>
            <span className="self-center text-[10px] text-neutral-600">
              视频音频与生成的字幕存在本地 ASR 服务的 .cache 目录，可在那边清理
            </span>
          </div>
        </div>
      </Section>

      <Section title="常见问题">
        <div className="divide-y divide-neutral-800 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900/40">
          {FAQ.map(([q, a], i) => (
            <div key={q}>
              <button
                type="button"
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="flex w-full items-center gap-2 px-4 py-3 text-left text-[12px] text-neutral-300 hover:bg-neutral-800/40"
              >
                <span className="text-neutral-600">{openFaq === i ? '▾' : '▸'}</span>
                {q}
              </button>
              {openFaq === i && (
                <p className="px-9 pb-3 text-[11px] leading-relaxed text-neutral-500">{a}</p>
              )}
            </div>
          ))}
        </div>
      </Section>

      <Section title="项目与文档">
        <div className="flex flex-wrap gap-3 text-[12px]">
          <a
            className="rounded-lg border border-neutral-800 px-3 py-2 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            href={`${GH_EXT}#readme`}
            target="_blank"
            rel="noreferrer"
          >
            yt_subtitle · README
          </a>
          <a
            className="rounded-lg border border-neutral-800 px-3 py-2 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            href={`${GH_EXT}/blob/main/docs/USER-GUIDE.md`}
            target="_blank"
            rel="noreferrer"
          >
            用户手册
          </a>
          <a
            className="rounded-lg border border-neutral-800 px-3 py-2 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            href={`${GH_EXT}/blob/main/docs/HANDOVER.md`}
            target="_blank"
            rel="noreferrer"
          >
            交接文档
          </a>
          <a
            className="rounded-lg border border-neutral-800 px-3 py-2 text-neutral-300 hover:border-neutral-700 hover:text-neutral-100"
            href={GH_PDF}
            target="_blank"
            rel="noreferrer"
          >
            pdf_trasllama（文档/截图识别）
          </a>
        </div>
        <p className="pt-2 text-[10px] text-neutral-600">版本 0.1.0 · 本地运行，不上传任何非识别内容</p>
      </Section>

      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-neutral-800 bg-neutral-900 px-4 py-2 text-[12px] text-neutral-200 shadow-xl">
          {toast}
        </div>
      )}
    </div>
  );
}
