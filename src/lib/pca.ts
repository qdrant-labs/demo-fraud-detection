// 2-D PCA by power iteration, shared by the evidence-panel scatter and the
// wall's "How Qdrant Sees It" panel. Both project a tenant's 31-d baseline plus
// the event onto the same two principal components, so the math lives in one
// place. ~30 lines, no dependency, trivial for ~800 points in 31 dims.

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

function normalize(v: number[]): number[] {
  const n = Math.sqrt(dot(v, v)) || 1;
  return v.map((x) => x / n);
}

export function mean(vectors: number[][], dim: number): number[] {
  const m = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) m[i] += v[i];
  if (vectors.length) for (let i = 0; i < dim; i++) m[i] /= vectors.length;
  return m;
}

// Top eigenvector of the covariance of `centered` via power iteration. If
// `deflate` is given, that component is projected out each step, yielding the
// next principal component.
function powerIteration(centered: number[][], dim: number, deflate?: number[]): number[] {
  let v = normalize(new Array(dim).fill(0).map((_, i) => (i === 0 ? 1 : 0.01)));
  for (let iter = 0; iter < 60; iter++) {
    const next = new Array(dim).fill(0);
    for (const x of centered) {
      const c = dot(x, v);
      for (let i = 0; i < dim; i++) next[i] += c * x[i];
    }
    let nv = normalize(next);
    if (deflate) {
      const proj = dot(nv, deflate);
      nv = normalize(nv.map((x, i) => x - proj * deflate[i]));
    }
    v = nv;
  }
  return v;
}

// Fit the two principal components of `vectors` and return a projector onto them.
// The projector centers each input by the fitted mean, so the event and its
// neighbors (projected with the same function) line up with the baseline cloud.
export function pcaProjector(vectors: number[][]): (v: number[]) => [number, number] {
  const dim = vectors[0]?.length ?? 0;
  const mu = mean(vectors, dim);
  const centered = vectors.map((v) => v.map((x, i) => x - mu[i]));
  const pc1 = powerIteration(centered, dim);
  const pc2 = powerIteration(centered, dim, pc1);
  return (v: number[]) => {
    const c = v.map((x, i) => x - mu[i]);
    return [dot(c, pc1), dot(c, pc2)];
  };
}

// Projector whose x-axis IS the anomaly: the direction from the neighbors'
// centroid to the event. The y-axis is the baseline's top principal component
// orthogonal to that. Plain PCA hides an alert on screen: the fields that make
// an event anomalous (new merchant, escalation) are near-constant in the
// baseline, so the fitted components give them ~zero weight and the event
// lands on top of its neighbors. Fixing the x-axis to the event's own
// displacement makes the on-screen gap track the real 31-d distance.
// Falls back to plain PCA when no neighbor vectors are available.
export function anomalyProjector(
  vectors: number[][],
  event: number[],
  neighborVecs: number[][],
): (v: number[]) => [number, number] {
  const dim = vectors[0]?.length ?? 0;
  if (neighborVecs.length === 0) return pcaProjector(vectors);
  const anchor = mean(neighborVecs, dim);
  const dir = event.map((x, i) => x - anchor[i]);
  if (Math.sqrt(dot(dir, dir)) < 1e-9) return pcaProjector(vectors);
  const ax = normalize(dir);
  const mu = mean(vectors, dim);
  const centered = vectors.map((v) => v.map((x, i) => x - mu[i]));
  const ay = powerIteration(centered, dim, ax);
  return (v: number[]) => {
    const c = v.map((x, i) => x - mu[i]);
    return [dot(c, ax), dot(c, ay)];
  };
}
