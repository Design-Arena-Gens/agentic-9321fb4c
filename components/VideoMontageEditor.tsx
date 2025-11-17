'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';

type Clip = {
  id: string;
  file: File;
  name: string;
  url: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
};

type PreviewState = {
  activeIndex: number;
  isPlaying: boolean;
};

const formatTime = (value: number) => {
  const clamped = Math.max(0, value);
  const hours = Math.floor(clamped / 3600)
    .toString()
    .padStart(2, '0');
  const minutes = Math.floor((clamped % 3600) / 60)
    .toString()
    .padStart(2, '0');
  const seconds = (clamped % 60).toFixed(2).padStart(5, '0');
  return `${hours}:${minutes}:${seconds}`;
};

const readDuration = (url: string) =>
  new Promise<number>((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.src = url;
    video.onloadedmetadata = () => {
      if (!Number.isFinite(video.duration)) {
        reject(new Error('تعذّر قراءة مدة الفيديو'));
        return;
      }
      resolve(video.duration);
    };
    video.onerror = () => reject(new Error('تعذّر تحميل الفيديو'));
  });

const createId = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).slice(2);
};

export default function VideoMontageEditor() {
  const [clips, setClips] = useState<Clip[]>([]);
  const [status, setStatus] = useState<string>('');
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ activeIndex: -1, isPlaying: false });

  const playerRef = useRef<HTMLVideoElement | null>(null);
  const ffmpegRef = useRef<FFmpeg | null>(null);

  const totalDuration = useMemo(
    () =>
      clips.reduce((sum, clip) => {
        const length = Math.max(0, clip.trimEnd - clip.trimStart);
        return sum + length;
      }, 0),
    [clips],
  );

  const loadFFmpeg = useCallback(async () => {
    if (ffmpegRef.current) {
      return ffmpegRef.current;
    }
    const instance = new FFmpeg();
    instance.on('progress', ({ progress: value }) => {
      setProgress(Math.max(0, Math.min(1, value)));
    });
    setStatus('جاري تحميل محرك المعالجة...');
    await instance.load();
    ffmpegRef.current = instance;
    return instance;
  }, []);

  const handleFiles = useCallback(
    async (fileList: FileList | File[]) => {
      const files = Array.from(fileList).filter((file) => file.type.startsWith('video/'));
      if (!files.length) {
        setStatus('لم يتم العثور على ملفات فيديو صالحة.');
        return;
      }
      setStatus('جاري تحليل الملفات المرفوعة...');

      const clipData = await Promise.all(
        files.map(async (file) => {
          const url = URL.createObjectURL(file);
          const duration = await readDuration(url);
          return {
            id: createId(),
            file,
            name: file.name,
            url,
            duration,
            trimStart: 0,
            trimEnd: duration,
          };
        }),
      );

      setClips((prev) => [...prev, ...clipData]);
      setStatus('تمت إضافة المقاطع بنجاح.');
    },
    [],
  );

  const updateClip = useCallback((id: string, updates: Partial<Clip>) => {
    setClips((prev) =>
      prev.map((clip) =>
        clip.id === id
          ? {
              ...clip,
              ...updates,
            }
          : clip,
      ),
    );
  }, []);

  const removeClip = useCallback((id: string) => {
    setClips((prev) => prev.filter((clip) => clip.id !== id));
  }, []);

  const moveClip = useCallback((id: string, direction: -1 | 1) => {
    setClips((prev) => {
      const index = prev.findIndex((clip) => clip.id === id);
      if (index === -1) return prev;
      const target = index + direction;
      if (target < 0 || target >= prev.length) return prev;
      const reordered = [...prev];
      const [item] = reordered.splice(index, 1);
      reordered.splice(target, 0, item);
      return reordered;
    });
  }, []);

  const startPreview = useCallback(() => {
    if (!clips.length) {
      setStatus('أضف مقاطع قبل المعاينة.');
      return;
    }
    setPreview({ activeIndex: 0, isPlaying: true });
    setStatus('يتم تشغيل المعاينة.');
    const video = playerRef.current;
    if (!video) return;
    const firstClip = clips[0];
    const startPlayback = () => {
      video.currentTime = firstClip.trimStart;
      void video.play();
    };
    video.onloadedmetadata = () => {
      startPlayback();
      video.onloadedmetadata = null;
    };
    video.src = firstClip.url;
    if (video.readyState >= 1) {
      startPlayback();
    }
  }, [clips]);

  const stopPreview = useCallback(() => {
    setPreview({ activeIndex: -1, isPlaying: false });
    const video = playerRef.current;
    if (video) {
      video.pause();
      video.onloadedmetadata = null;
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  const handlePreviewTimeUpdate = useCallback(() => {
    const video = playerRef.current;
    if (!video || !preview.isPlaying || preview.activeIndex < 0) return;
    const clip = clips[preview.activeIndex];
    if (!clip) return;
    if (video.currentTime >= clip.trimEnd - 0.05) {
      const nextIndex = preview.activeIndex + 1;
      if (nextIndex >= clips.length) {
        stopPreview();
      } else {
        const nextClip = clips[nextIndex];
        setPreview({ activeIndex: nextIndex, isPlaying: true });
        const handleLoaded = () => {
          video.currentTime = nextClip.trimStart;
          void video.play();
          video.onloadedmetadata = null;
        };
        video.onloadedmetadata = handleLoaded;
        video.src = nextClip.url;
        if (video.readyState >= 1) {
          handleLoaded();
        }
      }
    }
  }, [clips, preview, stopPreview]);

  const exportMontage = useCallback(async () => {
    if (!clips.length) {
      setStatus('أضف مقاطع قبل التصدير.');
      return;
    }
    setProcessing(true);
    setProgress(0);
    setStatus('جاري تهيئة عملية التصدير...');
    setResultUrl(null);

    try {
      const ffmpeg = await loadFFmpeg();

      const tempFiles: string[] = [];
      const trimmedFiles: string[] = [];

      for (const [index, clip] of clips.entries()) {
        const originalName = `clip_${index}.mp4`;
        const trimmedName = `clip_${index}_trimmed.mp4`;
        await ffmpeg.writeFile(originalName, await fetchFile(clip.file));
        tempFiles.push(originalName);

        const needsTrim = clip.trimStart > 0 || clip.trimEnd < clip.duration;
        if (needsTrim) {
          setStatus(`جاري قص المقطع ${clip.name}...`);
          await ffmpeg.exec([
            '-i',
            originalName,
            '-ss',
            formatTime(clip.trimStart),
            '-to',
            formatTime(clip.trimEnd),
            '-c',
            'copy',
            trimmedName,
          ]);
          trimmedFiles.push(trimmedName);
        } else {
          trimmedFiles.push(originalName);
        }
      }

      const concatFile = trimmedFiles.map((file) => `file '${file}'`).join('\n');
      await ffmpeg.writeFile('concat.txt', concatFile);

      setStatus('جاري دمج المقاطع...');
      await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', '-c', 'copy', 'output.mp4']);

      const data = await ffmpeg.readFile('output.mp4');
      const buffer = data instanceof Uint8Array ? new Uint8Array(data) : new TextEncoder().encode(data);
      const blob = new Blob([buffer], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);
      setResultUrl(url);
      setStatus('تم إنشاء الفيديو النهائي. يمكنك تنزيله الآن.');

      try {
        await ffmpeg.deleteFile('output.mp4');
        await ffmpeg.deleteFile('concat.txt');
      } catch {
        // ignore cleanup errors
      }

      for (const file of tempFiles) {
        try {
          await ffmpeg.deleteFile(file);
        } catch {
          // ignore
        }
      }

      for (const file of trimmedFiles) {
        if (!tempFiles.includes(file)) {
          try {
            await ffmpeg.deleteFile(file);
          } catch {
            // ignore
          }
        }
      }
    } catch (error) {
      console.error(error);
      setStatus('حدث خطأ أثناء التصدير. حاول مرة أخرى.');
    } finally {
      setProcessing(false);
      setProgress(0);
    }
  }, [clips, loadFFmpeg]);

  return (
    <div className="editor">
      <header className="header">
        <h1>أداة مونتاج الفيديو</h1>
        <p>قم برفع مقاطع متعددة، قصّ ما تحتاجه، ثم دمجها في فيديو واحد قابل للتنزيل.</p>
      </header>

      <section className="upload">
        <label className="upload-label">
          اختر ملفات الفيديو
          <input
            type="file"
            accept="video/*"
            multiple
            onChange={(event) => {
              if (event.target.files) {
                void handleFiles(event.target.files);
                event.target.value = '';
              }
            }}
          />
        </label>
        <div
          className="dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            if (event.dataTransfer.files) {
              void handleFiles(event.dataTransfer.files);
            }
          }}
        >
          اسحب الملفات هنا أو استخدم زر الرفع بالأعلى.
        </div>
      </section>

      {clips.length > 0 && (
        <>
          <section className="clips">
            <h2>المقاطع ({clips.length})</h2>
            <p>المدة الإجمالية بعد القص: {totalDuration.toFixed(2)} ثانية</p>
            <div className="clip-list">
              {clips.map((clip, index) => (
                <article key={clip.id} className="clip-card">
                  <div className="clip-header">
                    <strong>{clip.name}</strong>
                    <span>{clip.duration.toFixed(2)} ث</span>
                  </div>
                  <video src={clip.url} controls className="clip-video" />
                  <div className="controls">
                    <div className="field">
                      <label>بداية المقطع (ثانية)</label>
                      <input
                        type="number"
                        min={0}
                        max={clip.trimEnd}
                        step={0.1}
                        value={clip.trimStart.toFixed(2)}
                        onChange={(event) => {
                          const value = Math.min(
                            Math.max(0, Number(event.target.value)),
                            clip.trimEnd - 0.1,
                          );
                          updateClip(clip.id, { trimStart: value });
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={clip.duration}
                      step={0.1}
                      value={clip.trimStart}
                      onChange={(event) => {
                        const value = Math.min(Number(event.target.value), clip.trimEnd - 0.1);
                        updateClip(clip.id, { trimStart: value });
                      }}
                    />
                    <div className="field">
                      <label>نهاية المقطع (ثانية)</label>
                      <input
                        type="number"
                        min={clip.trimStart + 0.1}
                        max={clip.duration}
                        step={0.1}
                        value={clip.trimEnd.toFixed(2)}
                        onChange={(event) => {
                          const value = Math.max(
                            Math.min(Number(event.target.value), clip.duration),
                            clip.trimStart + 0.1,
                          );
                          updateClip(clip.id, { trimEnd: value });
                        }}
                      />
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={clip.duration}
                      step={0.1}
                      value={clip.trimEnd}
                      onChange={(event) => {
                        const value = Math.max(Number(event.target.value), clip.trimStart + 0.1);
                        updateClip(clip.id, { trimEnd: value });
                      }}
                    />
                  </div>
                  <div className="actions">
                    <button type="button" onClick={() => moveClip(clip.id, -1)} disabled={index === 0}>
                      ↑ للأعلى
                    </button>
                    <button
                      type="button"
                      onClick={() => moveClip(clip.id, 1)}
                      disabled={index === clips.length - 1}
                    >
                      ↓ للأسفل
                    </button>
                    <button type="button" className="danger" onClick={() => removeClip(clip.id)}>
                      حذف
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="preview">
            <h2>معاينة</h2>
            <div className="preview-controls">
              <button type="button" onClick={startPreview} disabled={processing || preview.isPlaying}>
                تشغيل المعاينة
              </button>
              <button type="button" onClick={stopPreview} disabled={!preview.isPlaying}>
                إيقاف المعاينة
              </button>
            </div>
            <video
              ref={playerRef}
              className="preview-player"
              controls
              onTimeUpdate={handlePreviewTimeUpdate}
              onEnded={handlePreviewTimeUpdate}
            />
          </section>

          <section className="export">
            <h2>تصدير</h2>
            <button type="button" onClick={exportMontage} disabled={processing}>
              {processing ? 'جاري المعالجة...' : 'تصدير الفيديو النهائي'}
            </button>
            {processing && (
              <div className="progress">
                <div className="bar" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
            )}
            {resultUrl && (
              <div className="result">
                <a href={resultUrl} download="montage.mp4">
                  تنزيل الفيديو المنتج
                </a>
                <video src={resultUrl} controls className="result-video" />
              </div>
            )}
          </section>
        </>
      )}

      <section className="status">
        <strong>الحالة:</strong> <span>{status || 'بداية جديدة - ارفع مقاطعك.'}</span>
      </section>

      <footer className="footer">
        <p>
          تعمل الأداة بالكامل داخل المتصفح باستخدام WebAssembly، لذا تبقى ملفاتك على جهازك ولا يتم رفعها للخادم.
        </p>
      </footer>
    </div>
  );
}
