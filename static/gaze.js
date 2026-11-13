// Rough delivery signals from the camera in video-call mode: how often the face was in frame,
// turned toward the screen, and smiling. Everything is computed on this device with MediaPipe;
// no image is recorded or uploaded, only three percentages end up in the report.

const VISION = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const EVERY_MS = 300;
const MIN_FRAMES = 20;

// Blendshape scores run from 0 to 1. Reading a question on screen pulls the eyes down a
// little, so "down" gets more room than sideways or up before it counts as looking away.
function facingScreen(s) {
  const side = Math.max(s.eyeLookOutLeft, s.eyeLookOutRight);
  const down = (s.eyeLookDownLeft + s.eyeLookDownRight) / 2;
  const up = (s.eyeLookUpLeft + s.eyeLookUpRight) / 2;
  return side < 0.5 && down < 0.62 && up < 0.5;
}

export async function watchFace(video) {
  const { FaceLandmarker, FilesetResolver } = await import(`${VISION}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${VISION}/wasm`);
  const landmarker = await FaceLandmarker.createFromOptions(files, {
    baseOptions: { modelAssetPath: MODEL },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
  });
  const seen = { frames: 0, face: 0, facing: 0, smiling: 0 };
  let counting = false;

  const timer = setInterval(() => {
    if (!counting || video.readyState < 2) return;
    let shapes;
    try {
      shapes = landmarker.detectForVideo(video, performance.now()).faceBlendshapes?.[0]?.categories;
    } catch {
      return;
    }
    seen.frames += 1;
    if (!shapes) return;
    const s = Object.fromEntries(shapes.map((c) => [c.categoryName, c.score]));
    seen.face += 1;
    if (facingScreen(s)) seen.facing += 1;
    if ((s.mouthSmileLeft + s.mouthSmileRight) / 2 > 0.4) seen.smiling += 1;
  }, EVERY_MS);

  return {
    // Only the candidate's own speaking turns are measured.
    count(on) {
      counting = on;
    },
    stop() {
      clearInterval(timer);
      landmarker.close();
      if (seen.frames < MIN_FRAMES) return null;
      const pct = (n, of) => Math.round((n / of) * 100);
      // With the face rarely in view, facing and smiling would be noise, so they are left out.
      const enough = seen.face >= MIN_FRAMES / 2;
      return {
        in_frame: pct(seen.face, seen.frames),
        facing: enough ? pct(seen.facing, seen.face) : null,
        smiling: enough ? pct(seen.smiling, seen.face) : null,
      };
    },
  };
}
