import type { FrameSource, Pt } from './types';

/**
 * Live laptop camera. We ask for 1280x720; webcams that can't will give
 * their best. Continuous auto-exposure is a real problem for ink diffing
 * (the page brightens/darkens as the hand enters), so we attempt to lock
 * exposure/white-balance where the browser supports it and otherwise rely
 * on the gain normalization inside inkdiff.
 */
export async function openCamera(video: HTMLVideoElement): Promise<FrameSource> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      facingMode: 'user',
      frameRate: { ideal: 30 },
    },
    audio: false,
  });

  const track = stream.getVideoTracks()[0];
  await tryLockExposure(track);

  video.srcObject = stream;
  await video.play();

  return {
    kind: 'camera',
    element: video,
    get width() {
      return video.videoWidth || 1280;
    },
    get height() {
      return video.videoHeight || 720;
    },
    tick: () => true,
    tipOverride: null as Pt | null,
  };
}

async function tryLockExposure(track: MediaStreamTrack): Promise<void> {
  try {
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const constraints: MediaTrackConstraintSet[] = [];
    const modes = (name: string): string[] => (caps[name] as string[] | undefined) ?? [];
    if (modes('exposureMode').includes('manual')) {
      constraints.push({ exposureMode: 'manual' } as MediaTrackConstraintSet);
    }
    if (modes('whiteBalanceMode').includes('manual')) {
      constraints.push({ whiteBalanceMode: 'manual' } as MediaTrackConstraintSet);
    }
    if (constraints.length) await track.applyConstraints({ advanced: constraints });
  } catch {
    // Best effort only — most laptop cameras refuse; inkdiff normalizes instead.
  }
}

let lastObjectUrl: string | null = null;

/** A user-provided recording of writing, for repeatable testing. */
export function openVideoFile(video: HTMLVideoElement, file: File): Promise<FrameSource> {
  return new Promise((resolve, reject) => {
    video.srcObject = null;
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(file);
    video.src = lastObjectUrl;
    video.loop = false;
    video.onloadedmetadata = async () => {
      try {
        await video.play();
        resolve({
          kind: 'video',
          element: video,
          get width() {
            return video.videoWidth;
          },
          get height() {
            return video.videoHeight;
          },
          tick: () => !video.ended,
          tipOverride: null,
        });
      } catch (e) {
        reject(e);
      }
    };
    video.onerror = () => reject(new Error('Could not load video file'));
  });
}
