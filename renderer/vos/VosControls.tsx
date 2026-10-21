import Head from 'next/head';
import { useEffect, useState } from 'react';
import { useTranslation } from 'next-i18next';
import { useLanguage, setLanguageMode } from './index';
import type { LanguageMode } from './vosLocale';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '../components/ui/dropdown-menu';
import { Info, Languages } from 'lucide-react';

const namespaces = ['common', 'home', 'tasks', 'toolbox', 'modelsControl', 'translateControl', 'dubbing', 'subtitleMerge', 'resources', 'glossary', 'launchpad', 'download', 'settings', 'parameters', 'voiceClone'];
export function VosControls() {
  const { i18n } = useTranslation();
  const { locale, mode } = useLanguage();
  const [status, setStatus] = useState<any>(null);
  const [runtime, setRuntime] = useState<any>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [error, setError] = useState('');
  const lang = locale === 'en-US' ? 'en' : locale === 'zh-TW' ? 'zh-TW' : 'zh';
  const label = (zh: string, tw: string, en: string) => lang === 'en' ? en : lang === 'zh-TW' ? tw : zh;
  useEffect(() => {
    let live = true;
    void Promise.all(namespaces.map(async ns => {
      if (i18n.hasResourceBundle(lang, ns)) return;
      const res = await fetch(`/app/com.ictrek.v-sub/locales/${lang}/${ns}.json`);
      if (!res.ok) throw new Error('Translation could not be loaded');
      i18n.addResourceBundle(lang, ns, await res.json(), true, true);
    })).then(() => { if (live) void i18n.changeLanguage(lang); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [i18n, lang]);
  useEffect(() => {
    const onError = (e: any) => setError(e.detail);
    window.addEventListener('v-sub-auth-error', onError);
    const remove = window.ipc.on('vos:error', (...args) => setError(String(args[0])));
    const refresh = () => window.ipc.invoke('vos:router-status').then(setStatus).catch(e => setError(e.message));
    void refresh(); const timer = setInterval(refresh, 30000);
    return () => { remove(); clearInterval(timer); window.removeEventListener('v-sub-auth-error', onError); };
  }, []);
  useEffect(() => {
    if (!aboutOpen) return;
    void window.ipc.invoke('vos:runtime-status').then(setRuntime).catch(() => setRuntime(null));
  }, [aboutOpen]);
  const connection = error || status?.error || status?.local?.error;
  const gatewayState = status?.error || status?.local?.error || (status?.connected ? label('已连接', '已連線', 'connected') : '');
  const aboutRows: [string, string][] = [
    [label('应用版本', '應用版本', 'Version'), runtime?.version || '-'],
    ['App ID', runtime?.appId || 'com.ictrek.v-sub'],
    [label('运行配置', '執行組態', 'Profile'), runtime?.profile || '-'],
    [label('推理后端', '推理後端', 'Inference'), [runtime?.sherpaProvider, runtime?.sherpaVersion].filter(Boolean).join(' ') || '-'],
    [label('模型网关', '模型閘道', 'Gateway'), `${runtime?.gateway || 'http://v-scheduler:8080'}${gatewayState ? ` · ${gatewayState}` : ''}`],
  ];
  return <><Head><title>V-Sub</title></Head><div className="flex items-center justify-end gap-2 border-b bg-background px-4 py-2 text-sm">
    <a href={`${typeof window !== 'undefined' ? window.location.origin : ''}/#/app/app-drawer/com.ictrek.v-scheduler/v-scheduler`} target="_top" className="text-muted-foreground">V-Scheduler{status ? ` · ASR ${status.asr} / TTS ${status.tts}` : ''}</a>
    {connection && <span role="alert" className="text-destructive">{connection}</span>}
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="outline" size="sm"><Languages />{mode === 'auto' ? label('跟随 VOS', '跟隨 VOS', 'Follow VOS') : lang === 'en' ? 'English' : lang === 'zh-TW' ? '繁體中文' : '简体中文'}</Button></DropdownMenuTrigger>
      <DropdownMenuContent><DropdownMenuGroup>{([['auto', label('跟随 VOS', '跟隨 VOS', 'Follow VOS')], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['en-US', 'English']] as [LanguageMode, string][]).map(([value, title]) => <DropdownMenuItem key={value} onSelect={() => setLanguageMode(value)}>{title}</DropdownMenuItem>)}</DropdownMenuGroup></DropdownMenuContent>
    </DropdownMenu>
    <Button variant="outline" size="sm" onClick={() => setAboutOpen(true)} aria-label={label('关于', '關於', 'About')}><Info />{label('关于', '關於', 'About')}</Button>
    <Dialog open={aboutOpen} onOpenChange={setAboutOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{label('关于 V-Sub', '關於 V-Sub', 'About V-Sub')}</DialogTitle></DialogHeader>
        <DialogDescription>{label('VOS 字幕工作台', 'VOS 字幕工作臺', 'VOS subtitle and dubbing workbench')}</DialogDescription>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">{aboutRows.map(([name, value]) => <div key={name} className="contents"><dt className="text-muted-foreground">{name}</dt><dd className="break-all font-mono text-xs">{value}</dd></div>)}</dl>
      </DialogContent>
    </Dialog>
  </div></>;
}
