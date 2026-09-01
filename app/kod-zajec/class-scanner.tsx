"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import jsQR from "jsqr";
import { isNetworkError, isOffline, reportError, reportSuccess } from "@/lib/offline/connection";
import { enqueue } from "@/lib/offline/queue";
import { stationScanAction, type StationScanView } from "./actions";

// Kamera kiosku czytająca osobiste kody rotacyjne. To jest droga prowadzącego:
// kod żyje 30 s, więc trzeba stać przy tym urządzeniu, a nie mieć zdjęcie.
//
// Dekodowanie ma dwie drogi. Natywny BarcodeDetector (Chrome, Android) jest
// szybszy i nie kosztuje nic; Safari na iPadzie go nie ma, więc tam wchodzi
// jsQR na klatce z canvasu. Bez tego kiosk działałby tylko na Androidzie,
// a klub ma kupić tablet, jaki akurat będzie pod ręką.
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike;

function getDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector ?? null;
}

export function ClassScanner({
  locationId,
  locationName,
}: {
  locationId: string | null;
  locationName: string | null;
}) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const busyRef = useRef(false);
  // Kamera widzi ten sam kod wiele klatek z rzędu. Dławimy powtórki, ale
  // krócej niż 30 s, żeby kolejna osoba nie czekała na odblokowanie.
  const lastRef = useRef<{ code: string; at: number }>({ code: "", at: 0 });

  const [cameraOn, setCameraOn] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [result, setResult] = useState<StationScanView | null>(null);
  // Odbicie odłożone bez łącza. Osobno od wyniku z serwera, bo kiosk ma
  // powiedzieć wprost, że baza jeszcze o tym nie wie.
  const [queued, setQueued] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [pending, setPending] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const nativeDetector = getDetectorCtor() !== null;

  const submit = useCallback(
    async (code: string) => {
      if (!locationId || busyRef.current) return;
      const now = Date.now();
      if (code === lastRef.current.code && now - lastRef.current.at < 4000) return;
      lastRef.current = { code, at: now };

      // Godzina odczytu kodu. Tutaj to nie jest wygoda, tylko warunek
      // działania: kod rotacyjny żyje 30 sekund, więc sprawdzony wobec "teraz"
      // po powrocie wifi zawsze byłby wygasły. Zapisujemy moment, w którym
      // stanął przed kamerą, i wobec niego serwer go potem sprawdza.
      const scannedAt = new Date();
      const odloz = () => {
        enqueue({
          op: "ODBICIE_NA_ZAJECIACH",
          detail: [locationName, "kod z telefonu"].filter(Boolean).join(" · "),
          payload: { code: code.trim(), locationId },
          recordedAt: scannedAt,
        });
        setResult(null);
        setQueued(
          "Brak łącza - odbicie zapisane na tym urządzeniu z godziną skanu. Pójdzie do bazy samo, gdy wróci sieć.",
        );
      };

      if (isOffline()) {
        odloz();
        return;
      }

      busyRef.current = true;
      setPending(true);
      try {
        const res = await stationScanAction(code, locationId);
        reportSuccess();
        setQueued(null);
        setResult(res);
        if (res.ok) router.refresh();
      } catch (blad) {
        if (!isNetworkError(blad)) throw blad;
        reportError(blad);
        odloz();
      } finally {
        setPending(false);
        busyRef.current = false;
      }
    },
    [locationId, locationName, router],
  );

  // Odczyt klatki przez jsQR - droga dla przeglądarek bez BarcodeDetector
  // (Safari na iPadzie). Rysujemy klatkę na canvas i czytamy piksele.
  const readWithJsQr = useCallback((video: HTMLVideoElement): string | null => {
    const canvas = (canvasRef.current ??= document.createElement("canvas"));
    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    // Zmniejszona klatka wystarczy do odczytu kodu, a liczy się dużo szybciej -
    // to samo urządzenie ma jednocześnie wyświetlać podgląd.
    const scale = Math.min(1, 640 / width);
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return jsQR(image.data, image.width, image.height)?.data ?? null;
  }, []);

  useEffect(() => {
    if (!cameraOn) return;
    const Ctor = getDetectorCtor();
    const detector = Ctor ? new Ctor({ formats: ["qr_code"] }) : null;
    let stop = false;

    const tick = async () => {
      const video = videoRef.current;
      if (stop || !video || video.readyState < 2) return;
      try {
        const value = detector ? (await detector.detect(video))[0]?.rawValue : readWithJsQr(video);
        if (value) await submit(value);
      } catch {
        // pojedyncza nieudana klatka nic nie znaczy - próbujemy dalej
      }
    };
    // Bez natywnego dekodera klatka kosztuje więcej, więc próbujemy rzadziej.
    const id = window.setInterval(tick, detector ? 500 : 800);
    return () => {
      stop = true;
      window.clearInterval(id);
    };
  }, [cameraOn, submit, readWithJsQr]);

  const startCamera = useCallback(async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraOn(true);
    } catch {
      setCameraError("Nie udało się uruchomić kamery. Sprawdź zgodę albo użyj pola poniżej.");
    }
  }, []);

  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="flex flex-col gap-3">
      {cameraOn ? (
        <div className="border-line bg-surface overflow-hidden rounded-md border">
          <video
            ref={videoRef}
            playsInline
            muted
            className="aspect-video w-full bg-black object-cover"
          />
        </div>
      ) : null}

      {!cameraOn ? (
        <Button type="button" onClick={startCamera}>
          Włącz kamerę
        </Button>
      ) : (
        <p className="text-jade text-center font-mono text-xs tracking-widest uppercase">
          Kamera aktywna · pokaż kod z telefonu
        </p>
      )}

      {queued ? (
        <div
          role="status"
          className="border-amber/60 bg-amber/10 text-amber rounded-md border p-3 text-center text-sm"
        >
          {queued}
        </div>
      ) : null}

      {result ? (
        <div
          role="status"
          className={`rounded-md border p-3 text-center text-sm ${
            !result.ok
              ? "border-red/40 bg-red/5 text-red"
              : result.warn
                ? "border-amber/50 bg-amber/10 text-amber"
                : "border-jade/40 bg-jade/10 text-jade"
          }`}
        >
          {result.ok ? (
            <>
              <p className="font-medium">{result.title}</p>
              <p className="mt-0.5 font-mono text-xs">{result.detail}</p>
            </>
          ) : (
            result.message
          )}
        </div>
      ) : null}

      {cameraOn && !nativeDetector ? (
        <p className="text-muted-brand text-center text-[11px]">
          Odczyt programowy (ta przeglądarka nie ma wbudowanego dekodera) - trzymaj kod chwilę
          dłużej przed kamerą.
        </p>
      ) : null}
      {cameraError ? (
        <p className="border-red/40 bg-red/5 text-red rounded-md border p-2 text-xs">
          {cameraError}
        </p>
      ) : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const code = manual.trim();
          if (code) {
            setManual("");
            void submit(code);
          }
        }}
        className="flex gap-2"
      >
        <Input
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="Kod z czytnika ręcznego"
          className="border-line bg-surface-2"
        />
        <Button type="submit" variant="outline" disabled={pending}>
          Odbij
        </Button>
      </form>
    </div>
  );
}
