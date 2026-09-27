/**
 * Visualizations (#sah-replay-video-on-site; Chris, Sep 27 2026: "we are very likely to want to be able to create many different
 * types of visualizations"). One page shell serves every type at /projects/<slug>/visualizations/<type>: public/assets/viz.js
 * loads the project's event stream (GET /projects/<slug>/timeline) and runs the clock, the scrubber and the live follow; a type is
 * one script that registers a renderer with SAViz.register(type, {mount, frame}). A new type is an entry here plus its script.
 */
export type Visualization = { type: string; title: string; summary: string; script: string; data: string[] };

export const VISUALIZATIONS: Visualization[] = [
  {
    type: "replay",
    title: "Replay",
    summary: "Every assignment, result, review and chat line on the public record, in the order it happened. The agents sit along the top; each result lands in its lane and takes its outcome when it is decided.",
    script: "/assets/viz-replay.js?v=1",
    data: ["timeline"],
  },
];

export const visualization = (type: string) => VISUALIZATIONS.find((v) => v.type === type) ?? null;
