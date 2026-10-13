// Pixi static uniform/shader sync keeps Tauri's script-src policy intact.
import "pixi.js/unsafe-eval";
import type { ChillPrefs } from "../../preferences";
import { Application, Container, Graphics, Text } from "pixi.js";
import { hash, type Selection } from "../../model";
import { focusCamera } from "./camera";
import { plantPalette } from "./palette";
import { activityOf, helperHome, planLeg, speedFor, type Activity, type Home, type Point, type Spot } from "./motion";
import {
  leafScale,
  visibleFiles,
  type TerrariumActor as Bug,
  type TerrariumProject as Project,
} from "./model";
// All art is original, retained scene geometry. Render-time motion never mutates
// domain facts. Seeds give each project and bug its own persistent personality.
const W = 1200,
  H = 760;
const color = {
  ink: 0x283f3c,
  trunk: 0x76533e,
  bark: 0xa37a54,
  moss: 0x6c9661,
  mint: 0x9fddba,
  cream: 0xf3e5bc,
  peach: 0xe7a286,
};
function g(parent: Container): Graphics {
  const value = new Graphics();
  parent.addChild(value);
  return value;
}
function ellipse(
  parent: Container,
  x: number,
  y: number,
  rx: number,
  ry: number,
  c: number,
  alpha = 1,
): Graphics {
  return g(parent).ellipse(x, y, rx, ry).fill({ color: c, alpha });
}
function leaf(
  parent: Container,
  x: number,
  y: number,
  angle: number,
  size: number,
  c: number,
): Container {
  const box = new Container();
  box.label = "leaf";
  box.position.set(x, y);
  box.rotation = angle;
  box.scale.set(size);
  parent.addChild(box);
  const shape = g(box);
  shape
    .moveTo(0, 0)
    .bezierCurveTo(-20, -3, -31, -29, -17, -37)
    .bezierCurveTo(5, -37, 14, -17, 0, 0)
    .fill(c)
    .stroke({ color: color.ink, width: 1.5, alpha: 0.65 });
  g(box)
    .moveTo(0, -2)
    .bezierCurveTo(-7, -11, -12, -24, -15, -32)
    .stroke({ color: 0xd0e3a7, width: 1, alpha: 0.55 });
  g(box)
    .moveTo(-7, -13)
    .lineTo(1, -20)
    .moveTo(-11, -23)
    .lineTo(-22, -27)
    .stroke({ color: 0xd0e3a7, width: 0.8, alpha: 0.35 });
  return box;
}
function flower(
  parent: Container,
  x: number,
  y: number,
  seed: number,
  size = 0.8,
): Container {
  const box = new Container();
  parent.addChild(box);
  box.position.set(x, y);
  box.scale.set(size);
  const petals = [0xef9cbb, 0xb5a0e3, 0xf2c779, 0x88d7c7];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    ellipse(box, Math.cos(a) * 7, Math.sin(a) * 7, 5, 6, petals[seed % 4]!);
  }
  ellipse(box, 0, 0, 4, 4, 0xf2dc9a);
  ellipse(box, -1, -1, 1.3, 1.3, 0xfff1c5);
  return box;
}
function mushroom(
  parent: Container,
  x: number,
  y: number,
  scale: number,
  c: number,
) {
  const box = new Container();
  parent.addChild(box);
  box.position.set(x, y);
  box.scale.set(scale);
  g(box).roundRect(-2, -12, 4, 13, 2).fill(0xd8caa4);
  g(box)
    .moveTo(-12, -11)
    .bezierCurveTo(-12, -29, 12, -29, 12, -11)
    .bezierCurveTo(4, -6, -4, -6, -12, -11)
    .fill(c)
    .stroke({ color: color.ink, width: 1 });
  ellipse(box, -4, -17, 2, 1.5, 0xf3e8ce, 0.8);
  ellipse(box, 4, -19, 1.5, 1.2, 0xf3e8ce, 0.8);
}
function bugArt(bug: Bug): {
  body: Container;
  wings: Container[];
  legs: Graphics[];
  antennae: Graphics;
  halo: Graphics;
  eyes: Container;
  lens: Container;
  tool: Container;
  bench: Container;
  thought: Container;
} {
  const body = new Container();
  ellipse(body, 0, 13, 17, 5, 0x162f2a, 0.2);
  const halo = ellipse(body, 0, 0, 29, 25, 0xc0e8bd, 0.09);
  const legs: Graphics[] = [];
  for (const side of [-1, 1])
    for (let i = 0; i < 3; i++) {
      const l = g(body)
        .moveTo(side * 7, -2 + i * 5)
        .lineTo(side * 17, 2 + i * 4)
        .lineTo(side * 20, 6 + i * 4)
        .stroke({ color: 0x304448, width: 2.2, cap: "round" });
      legs.push(l);
    }
  const wings: Container[] = [];
  if (["bee", "moth", "butterfly"].includes(bug.role)) {
    for (const side of [-1, 1]) {
      const wing = new Container();
      wing.position.set(side * 6, 0);
      body.addChild(wing);
      wings.push(wing);
      ellipse(
        wing,
        side * 10,
        -6,
        12,
        19,
        bug.role === "butterfly"
          ? 0xb7a2d4
          : bug.role === "moth"
            ? 0xc6baa6
            : 0xc3e6e0,
        0.8,
      );
      ellipse(
        wing,
        side * 11,
        9,
        10,
        12,
        bug.role === "butterfly" ? 0x8bcaba : 0x9ccec8,
        0.65,
      );
      g(wing)
        .moveTo(0, 4)
        .lineTo(side * 15, -13)
        .stroke({ color: 0xf6ead1, width: 1, alpha: 0.45 });
    }
  }
  const palette = {
    ladybug: 0xdd8d78,
    beetle: 0x85bca3,
    bee: 0xe1bd76,
    moth: 0xaba1c0,
    butterfly: 0x9dbed3,
  };
  ellipse(body, 1, 3, 13, 16, 0x314951);
  ellipse(body, 0, 1, 12, 14, palette[bug.role]);
  g(body).moveTo(0, -11).lineTo(0, 14).stroke({ color: 0x425a53, width: 1.8 });
  if (bug.role === "bee") {
    for (const y of [-3, 5])
      g(body).roundRect(-10, y, 20, 4, 2).fill({ color: 0x6a6552, alpha: 0.8 });
  } else {
    for (const [x, y] of [
      [-6, -3],
      [6, -3],
      [-7, 5],
      [7, 5],
    ])
      ellipse(body, x!, y!, 2.6, 2.8, 0x41504d, 0.85);
  }
  ellipse(body, -5, -6, 4, 6, 0xffeccb, 0.22);
  // Small copper backpack, lit power cell, rosy cheeks and curious eyes.
  g(body)
    .roundRect(5, 1, 9, 11, 3)
    .fill(0x8f7054)
    .stroke({ color: 0x3e5550, width: 1.2 });
  g(body).roundRect(7, 3, 4, 5, 1).fill(0xc4e6b8);
  ellipse(body, 0, -14, 11, 9, 0x455c59);
  const eyes = new Container();
  eyes.position.set(0, -15);
  body.addChild(eyes);
  ellipse(eyes, -4, 0, 3.4, 4.5, 0xf1e7cd);
  ellipse(eyes, 4, 0, 3.4, 4.5, 0xf1e7cd);
  ellipse(eyes, -3, 0, 1.5, 2.2, 0x233d43);
  ellipse(eyes, 5, 0, 1.5, 2.2, 0x233d43);
  ellipse(body, -7, -10, 2.5, 1.4, 0xe6a7a0, 0.7);
  ellipse(body, 7, -10, 2.5, 1.4, 0xe6a7a0, 0.7);
  g(body)
    .moveTo(-2, -9)
    .quadraticCurveTo(0, -7, 2, -9)
    .stroke({ color: 0xc7dcba, width: 1, cap: "round" });
  const antennae = g(body)
    .moveTo(-5, -20)
    .quadraticCurveTo(-12, -31, -15, -27)
    .moveTo(5, -20)
    .quadraticCurveTo(11, -31, 15, -28)
    .stroke({ color: 0x49625a, width: 1.7, cap: "round" });
  ellipse(body, -15, -27, 2.7, 2.7, 0xb6dfad);
  ellipse(body, 15, -28, 2.2, 2.2, 0xe8ce95);
  const lens = new Container();
  body.addChild(lens);
  lens.position.set(17, -7);
  g(lens)
    .moveTo(3, 7)
    .lineTo(9, 15)
    .stroke({ color: 0xbda27c, width: 4, cap: "round" });
  g(lens)
    .circle(0, 0, 8)
    .fill({ color: 0xc4e9dc, alpha: 0.45 })
    .stroke({ color: 0xe6d7ac, width: 2 });
  g(lens)
    .moveTo(-4, -2)
    .lineTo(-1, -5)
    .stroke({ color: 0xe6f8eb, width: 2, alpha: 0.7 });
  const tool = new Container();
  body.addChild(tool);
  tool.position.set(18, 0);
  g(tool)
    .moveTo(0, 10)
    .lineTo(0, -10)
    .stroke({ color: 0xb8b9a1, width: 3, cap: "round" });
  g(tool)
    .moveTo(-4, -14)
    .lineTo(-4, -9)
    .quadraticCurveTo(0, -5, 4, -9)
    .lineTo(4, -14)
    .stroke({ color: 0xd5cfac, width: 3, cap: "round" });
  const bench = new Container();
  body.addChild(bench);
  bench.position.set(1, 26);
  g(bench)
    .roundRect(-24, -6, 48, 10, 3)
    .fill(0xa07a58)
    .stroke({ color: 0x3a5550, width: 1.5 });
  g(bench)
    .moveTo(-17, 3)
    .lineTo(-17, 13)
    .moveTo(17, 3)
    .lineTo(17, 13)
    .stroke({ color: 0x776146, width: 4 });
  g(bench)
    .roundRect(-11, -23, 22, 17, 3)
    .fill(0x475f58)
    .stroke({ color: 0x9cb8a0, width: 1.5 });
  g(bench).roundRect(-7, -20, 14, 10, 2).fill(0x8bb49a);
  g(bench)
    .moveTo(-4, -17)
    .lineTo(-1, -15)
    .lineTo(-4, -13)
    .stroke({ color: 0xd9e7b5, width: 1 });
  const thought = new Container();
  thought.position.set(0, -43);
  body.addChild(thought);
  for (let i = 0; i < 3; i++)
    ellipse(thought, (i - 1) * 7, -Math.sin(i) * 3, 2.2, 2.2, 0xc7e8bc);
  thought.visible = false;
  return {
    body,
    wings,
    legs,
    antennae,
    halo,
    lens,
    tool,
    bench,
    eyes,
    thought,
  };
}
type BugVisual = {
  bug: Bug;
  box: Container;
  art: ReturnType<typeof bugArt>;
  x: number;
  y: number;
  phase: number;
  marker: Graphics;
  settledAt: number;
  home: Home;
  anchored: boolean;
  /** The plant it lives on, the file leaf it works at (scene coordinates). */
  plant: PlantVisual;
  file: Point | null;
  activity: Activity;
  /** Its current leg: the points still to walk, then how long it stays. */
  route: Point[];
  dwell: number;
  spot: Spot;
  step: number;
  plan: string;
};
type PlantVisual = {
  box: Container;
  foliage: Container;
  anchors: Map<string, { x: number; y: number }>;
  slots: Map<string, number>;
  leaves: Map<string, Container>;
  flowerLayer: Container;
  lantern: Container;
  selectionRing: Graphics;
  name: Text;
  bugSlots: Map<string, number>;
  hero: boolean;
  versions: Map<string, string>;
  decorationKey: string;
  pulses: Map<string, { ring: Graphics; at: number }>;
  /** Where helpers can sit: every leaf of the plant, relative to its box. */
  perches: Point[];
  /** The plant's own leaves and their resting angles, for the flutter. */
  flutter: { item: Container; base: number; phase: number }[];
};
export class Terrarium {
  private app: Application;
  private world = new Container();
  private garden = new Container();
  private inhabitants = new Container();
  private plants = new Map<string, PlantVisual>();
  private bugs = new Map<string, BugVisual>();
  private motes: { box: Graphics; x: number; y: number; phase: number }[] = [];
  private last = 0;
  private clock = 0;
  private prefs: ChillPrefs;
  private reduced = false;
  private hidden = false;
  private destroyed = false;
  private resizeObserver: ResizeObserver;
  private select: (selection: Selection) => void;
  private current: Selection = null;
  private focus: string | null = null;
  private positions = new Map<string, number>();
  private zoom = 1;
  private toZoom = 1;
  private cameraX = 0;
  private toCameraX = 0;
  private cameraY = 0;
  private toCameraY = 0;
  private onVisibility = () => {
    this.hidden = document.hidden;
    this.syncTicker();
    if (!this.hidden) this.app.render();
  };
  private constructor(
    app: Application,
    host: HTMLElement,
    prefs: ChillPrefs,
    select: (selection: Selection) => void,
  ) {
    this.app = app;
    this.prefs = prefs;
    this.select = select;
    app.stage.addChild(this.world);
    this.environment();
    this.world.addChild(this.garden);
    this.garden.addChild(this.inhabitants);
    this.resizeObserver = new ResizeObserver(() => this.resize(host));
    this.resizeObserver.observe(host);
    this.resize(host);
    this.hidden = document.hidden;
    document.addEventListener("visibilitychange", this.onVisibility);
    app.ticker.add(this.tick);
    this.syncTicker();
  }
  static async create(
    host: HTMLElement,
    prefs: ChillPrefs,
    select: (selection: Selection) => void,
  ): Promise<Terrarium> {
    const app = new Application();
    try {
      await app.init({
        background: 0x1b3438,
        backgroundAlpha: 1,
        antialias: true,
        preference: "webgl",
        preserveDrawingBuffer: import.meta.env.DEV,
        resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        autoStart: false,
        sharedTicker: false,
        width: host.clientWidth,
        height: host.clientHeight,
      });
    } catch (error) {
      if (app.renderer) app.destroy(true, { children: true });
      throw error;
    }
    host.appendChild(app.canvas);
    app.canvas.setAttribute("aria-hidden", "true");
    return new Terrarium(app, host, prefs, select);
  }
  private resize(host: HTMLElement) {
    if (this.destroyed) return;
    this.app.renderer.resize(host.clientWidth, host.clientHeight);
    const s = Math.min(host.clientWidth / W, host.clientHeight / H);
    this.world.scale.set(s);
    this.world.position.set(
      (host.clientWidth - W * s) / 2,
      (host.clientHeight - H * s) / 2,
    );
    if (!this.hidden) this.app.render();
  }
  private environment() {
    const e = new Container();
    this.world.addChild(e);
    // Atmospheric depth, hand-stippled stars and a soft glass vessel.
    for (let i = 24; i > 0; i--)
      ellipse(e, 600, 390, 390 + i * 10, 235 + i * 6, 0x4f978b, 0.007);
    for (let i = 0; i < 64; i++) {
      const h = hash(`star${i}`);
      ellipse(
        e,
        80 + (h % 1040),
        55 + ((h >>> 11) % 510),
        0.6 + (h % 3) * 0.3,
        0.6 + (h % 3) * 0.3,
        0xb8d9cc,
        0.12 + (h % 4) * 0.07,
      );
    }
    g(e)
      .roundRect(105, 102, 990, 554, 245)
      .fill({ color: 0x96d0c5, alpha: 0.035 })
      .stroke({ color: 0x8bbfb7, width: 1, alpha: 0.24 });
    g(e)
      .roundRect(109, 105, 982, 550, 240)
      .stroke({ color: 0xa7e4d3, width: 3, alpha: 0.18 });
    g(e)
      .moveTo(148, 300)
      .bezierCurveTo(168, 160, 290, 115, 380, 119)
      .stroke({ color: 0xddf6e3, width: 4, alpha: 0.18, cap: "round" });
    g(e)
      .moveTo(154, 297)
      .bezierCurveTo(165, 232, 186, 201, 207, 177)
      .stroke({ color: 0xe0fae4, width: 12, alpha: 0.06, cap: "round" });
    ellipse(e, 600, 627, 488, 79, 0x091e23, 0.6);
    ellipse(e, 600, 610, 477, 77, 0x385b57);
    ellipse(e, 600, 596, 477, 77, 0x8c7454);
    ellipse(e, 600, 584, 474, 78, 0x405f47);
    for (let i = 9; i > 0; i--)
      ellipse(
        e,
        600,
        568 - i * 1.7,
        469 - i * 3,
        78 - i * 0.8,
        i % 2 ? 0x729766 : 0x6b8e5e,
        0.85,
      );
    g(e)
      .moveTo(139, 616)
      .bezierCurveTo(295, 687, 900, 687, 1061, 616)
      .stroke({ color: 0x83d0b2, width: 2, alpha: 0.55 });
    g(e)
      .moveTo(243, 650)
      .bezierCurveTo(420, 686, 775, 685, 953, 650)
      .stroke({ color: 0xc1f0d2, width: 3, alpha: 0.16 });
    for (let i = 0; i < 110; i++) {
      const h = hash(`moss${i}`);
      const x = 185 + (h % 840);
      const edge = Math.sqrt(Math.max(0, 1 - ((x - 600) / 440) ** 2));
      const y = 540 + ((h >>> 12) % 85) * edge;
      g(e)
        .moveTo(x, y)
        .lineTo(x - 3, y - 5)
        .moveTo(x, y)
        .lineTo(x + 3, y - 7)
        .stroke({ color: i % 3 ? 0x9fba75 : 0x406d50, width: 1.5, alpha: 0.6 });
    }
    for (const [x, y, s, c] of [
      [173, 566, 0.9, 0xb0a3ca],
      [1020, 572, 0.7, 0xd79999],
      [920, 606, 0.5, 0xc4b1d3],
      [290, 612, 0.45, 0xd6bc8a],
    ])
      mushroom(e, x!, y!, s!, c!);
    for (const [x, y] of [
      [212, 588],
      [961, 579],
      [852, 624],
      [380, 618],
    ]) {
      ellipse(e, x!, y!, 9, 5, 0x304e48, 0.7);
      ellipse(e, x! - 2, y! - 2, 7, 4, 0x82968a, 0.7);
    }
    for (let i = 0; i < 20; i++) {
      const h = hash(`mote${i}`);
      const x = 175 + (h % 850),
        y = 240 + ((h >>> 12) % 320);
      const box = ellipse(e, x, y, 1.5, 1.5, i % 3 ? 0xcfe6a7 : 0xb1cadd, 0.45);
      this.motes.push({ box, x, y, phase: h % 100 });
    }
  }
  private plant(project: Project, slot: number, total: number): PlantVisual {
    const box = new Container();
    // The project's id keys the plant's sway, shared with its helpers.
    box.label = project.id;
    this.garden.addChildAt(box, this.garden.children.length - 1);
    // Stable allocation in a two-row garden. Project identity chooses its foliage.
    const arrangement = [
      [590, 510],
      [290, 555],
      [890, 550],
      [430, 605],
      [710, 610],
      [1020, 600],
    ];
    const [x, y] = total === 1 ? [600, 553] : arrangement[slot % 6]!;
    box.position.set(x!, y!);
    const seed = hash(project.id),
      kind = seed % 4,
      hero = total === 1 || slot % 6 === 0;
    const palette = plantPalette(project.id);
    const tone = (index: number) => palette[index % palette.length]!;
    const height = hero ? 270 : [165, 188, 145, 170][kind]!;
    ellipse(box, 0, 3, 75, 18, 0x183c32, 0.26);
    if (!hero) {
      g(box)
        .moveTo(-35, -10)
        .lineTo(-27, 23)
        .quadraticCurveTo(0, 37, 27, 23)
        .lineTo(35, -10)
        .fill(kind === 1 ? 0x859c8e : 0xad7c61)
        .stroke({ color: 0x4b6351, width: 2 });
      g(box)
        .moveTo(-30, -6)
        .lineTo(-23, 21)
        .quadraticCurveTo(-12, 27, -4, 27)
        .lineTo(-7, -5)
        .fill({ color: 0xe1ab7c, alpha: 0.24 });
      ellipse(box, 0, -10, 36, 11, 0xc39b73);
      ellipse(box, 0, -10, 29, 7, 0x4e5840);
    } else {
      g(box)
        .moveTo(-44, 7)
        .quadraticCurveTo(-13, -12, -14, -38)
        .lineTo(12, -38)
        .quadraticCurveTo(15, -10, 43, 6)
        .quadraticCurveTo(12, 3, 0, -9)
        .quadraticCurveTo(-17, 6, -44, 7)
        .fill(color.trunk);
    }
    if (hero)
      g(box)
        .moveTo(-14, -12)
        .bezierCurveTo(-25, -75, -3, -120, -9, -181)
        .quadraticCurveTo(-9, -232, 3, -270)
        .quadraticCurveTo(6, -224, 8, -190)
        .bezierCurveTo(14, -122, 2, -73, 15, -12)
        .closePath()
        .fill(color.trunk);
    else if (kind === 0)
      g(box)
        .moveTo(0, -12)
        .bezierCurveTo(-10, -65, 12, -112, 0, -height)
        .stroke({ color: color.trunk, width: 10, cap: "round" });
    if (hero || kind === 0)
      g(box)
        .moveTo(-3, -15)
        .bezierCurveTo(-12, -66, 9, -111, -2, -height + 4)
        .stroke({ color: color.bark, width: 3, cap: "round" });
    const foliage = new Container();
    box.addChild(foliage);
    const anchors = new Map<string, { x: number; y: number }>();
    // Four botanical silhouettes: branching sapling, climbing vine, fern and
    // a flowering meadow pot. File foliage remains a separate activity layer.
    if (!hero && kind === 1) {
      g(foliage)
        .moveTo(-12, -10)
        .bezierCurveTo(52, -70, -60, -122, 12, -192)
        .stroke({ color: 0x75906a, width: 5, cap: "round" });
      for (let i = 0; i < 9; i++) {
        const y = -25 - i * 19;
        const x = Math.sin(i * 0.9) * 22;
        const side = i % 2 ? 1 : -1;
        g(foliage)
          .moveTo(x, y)
          .quadraticCurveTo(x + side * 17, y - 9, x + side * 28, y - 18)
          .stroke({ color: 0x75906a, width: 2 });
        leaf(foliage, x + side * 28, y - 18, side * 0.9, 1.15, tone(i));
      }
    } else if (!hero && kind === 2) {
      for (let f = -2; f <= 2; f++) {
        const topX = f * 33,
          topY = -172 + Math.abs(f) * 18;
        g(foliage)
          .moveTo(0, -12)
          .quadraticCurveTo(topX * 0.25, topY * 0.8, topX, topY)
          .stroke({ color: 0x799969, width: 3, cap: "round" });
        for (let i = 0; i < 7; i++) {
          const t = 0.22 + i * 0.11,
            x = topX * t * t,
            y = -12 + (topY + 12) * t;
          const size = 0.64 - i * 0.065;
          leaf(foliage, x, y, -0.95 + f * 0.09, size, tone(i));
          leaf(foliage, x + 2, y - 3, 1.1 + f * 0.09, size, tone(i + 1));
        }
      }
    } else if (!hero && kind === 3) {
      for (let i = 0; i < 5; i++) {
        const side = i % 2 ? -1 : 1;
        const x = (i - 2) * 28,
          y = -130 - (i % 3) * 18;
        g(foliage)
          .moveTo(0, -12)
          .bezierCurveTo(x * 0.8, -45, x - side * 15, y + 50, x, y)
          .stroke({ color: 0x71966d, width: 3, cap: "round" });
        leaf(foliage, x * 0.7, y + 49, -side * 0.9, 1.05, tone(i));
        leaf(foliage, x, y + 10, side * 0.8, 0.6, tone(i + 1));
        flower(foliage, x, y - 7, seed + i * 3, 0.85);
      }
    }
    for (let i = 0; i < (hero ? 10 : kind === 0 ? 12 : 0); i++) {
      const side = i % 2 ? -1 : 1;
      const level = Math.floor(i / 2);
      const yy = hero
        ? -154 - level * 24 + (i % 2) * 7
        : -42 - level * (kind === 1 ? 28 : kind === 2 ? 19 : 24);
      const xx = hero
        ? side * (105 - Math.abs(level - 1.5) * 19)
        : side *
          (kind === 2
            ? 62 - level * 4
            : kind === 3
              ? 28 + level * 5
              : 38 + (level % 3) * 9);
      g(foliage)
        .moveTo(0, hero ? -100 - level * 25 : yy + 22)
        .quadraticCurveTo(xx * 0.45, hero ? yy + 38 : yy + 9, xx, yy - 7)
        .stroke({
          color: color.trunk,
          width: hero ? 8 - level * 0.9 : 3.5,
          cap: "round",
        });
      leaf(
        foliage,
        xx,
        yy - 6,
        side * (hero ? 0.65 : kind === 1 ? 0.22 : kind === 2 ? 1.1 : 0.55),
        hero ? 0.95 : kind === 2 ? 1.2 : kind === 3 ? 0.85 : 0.95,
        tone(i),
      );
      leaf(foliage, xx * 0.65, yy + 5, -side * 0.95, 0.6, tone(i + 1));
      if (hero) {
        leaf(foliage, xx + side * 17, yy - 20, side * 1.1, 0.8, tone(i + 2));
        leaf(foliage, xx + side * 5, yy - 40, side * 0.3, 0.85, tone(i));
        leaf(foliage, xx * 0.45, yy - 23, -side * 0.5, 0.85, tone(i + 1));
        leaf(foliage, xx - side * 17, yy - 24, -side * 0.55, 0.75, tone(i + 3));
        g(foliage)
          .moveTo(xx * 0.55, yy + 12)
          .quadraticCurveTo(xx * 0.8, yy - 20, xx - side * 17, yy - 24)
          .stroke({ color: color.trunk, width: 2, cap: "round" });
      }
      if (i % 5 === kind)
        flower(foliage, xx + side * 5, yy - 20, seed + i, 0.7);
    }
    const flutter = foliage.children
      .filter((child) => child.label === "leaf")
      .map((item, i) => ({ item, base: item.rotation, phase: (hash(project.id) % 7) + i * 0.83 }));
    const perches = flutter.map(({ item }) => ({ x: item.x, y: item.y }));
    const flowerLayer = new Container();
    box.addChild(flowerLayer);
    const lantern = new Container();
    lantern.position.set(45, 5);
    box.addChild(lantern);
    g(lantern)
      .moveTo(0, 0)
      .lineTo(0, -35)
      .quadraticCurveTo(9, -43, 15, -35)
      .stroke({ color: 0x9a936b, width: 2 });
    ellipse(lantern, 15, -26, 15, 16, 0xf1ca83, 0.08);
    g(lantern)
      .roundRect(9, -34, 12, 15, 3)
      .fill(0xe9bd79)
      .stroke({ color: 0x796e53, width: 2 });
    lantern.visible = false;
    const selectionRing = g(box)
      .ellipse(0, 5, 83, 23)
      .stroke({ color: 0xd9dfaf, alpha: 0.55, width: 1.5 });
    selectionRing.visible = false;
    const hit = g(box)
      .rect(
        hero ? -125 : -90,
        hero ? -305 : -205,
        hero ? 250 : 180,
        hero ? 370 : 270,
      )
      .fill({ color: 0xffffff, alpha: 0 });
    hit.eventMode = "static";
    hit.cursor = "pointer";
    hit.on("pointertap", () =>
      this.select({ kind: "project", id: project.id }),
    );
    // Invisible hit plane goes behind file and bug hit regions.
    box.setChildIndex(hit, 0);
    const name = new Text({
      text: project.name,
      style: {
        fontFamily: "system-ui, sans-serif",
        fontSize: 13,
        fontWeight: "500",
        fill: 0xf1e8c9,
        align: "center",
        wordWrap: true,
        breakWords: true,
        wordWrapWidth: 150,
        lineHeight: 16,
      },
    });
    name.anchor.set(0.5, 0);
    name.position.set(0, 43);
    name.eventMode = "none";
    box.addChild(name);
    return {
      box,
      foliage,
      anchors,
      slots: new Map(),
      leaves: new Map(),
      flowerLayer,
      lantern,
      selectionRing,
      name,
      bugSlots: new Map(),
      hero,
      versions: new Map(),
      decorationKey: "",
      pulses: new Map(),
      perches,
      flutter,
    };
  }
  update(
    projects: Project[],
    prefs: ChillPrefs,
    reduced: boolean,
    selection: Selection,
    focus: string | null,
    now: number,
    light = "dusk",
  ) {
    if (this.destroyed) return;
    this.app.renderer.background.color =
      light === "moonlight"
        ? 0x192b3d
        : light === "sunrise"
          ? 0x3b4b49
          : 0x1b3438;
    this.prefs = prefs;
    this.reduced = reduced;
    this.current = selection;
    this.focus = focus;
    this.app.ticker.maxFPS = prefs.economy ? 30 : 60;
    const resolution = Math.min(
      window.devicePixelRatio || 1,
      prefs.economy ? 1.5 : 2,
    );
    if (this.app.renderer.resolution !== resolution) {
      this.app.renderer.resolution = resolution;
      this.app.renderer.resize(this.app.screen.width, this.app.screen.height);
    }
    const ids = new Set(projects.map((p) => p.id));
    let remainingBugs = 40;
    const shownBugIds = new Set<string>();
    for (const [id, plant] of this.plants)
      if (!ids.has(id)) {
        plant.box.destroy({ children: true });
        this.plants.delete(id);
      }
    for (const [id, bug] of this.bugs)
      if (!projects.some((p) => p.bugs.some((a) => a.id === id))) {
        bug.box.destroy({ children: true });
        this.bugs.delete(id);
      }
    for (const project of projects) {
      let plant = this.plants.get(project.id);
      if (!plant) {
        let slot = this.positions.get(project.id);
        const occupied = new Set(
          [...this.plants.keys()].map((id) => this.positions.get(id)! % 6),
        );
        if (slot === undefined || occupied.has(slot % 6)) {
          slot = 0;
          while (occupied.has(slot) && occupied.size < 6) slot = (slot + 1) % 6;
          this.positions.set(project.id, slot);
        }
        plant = this.plant(project, slot, projects.length);
        this.plants.set(project.id, plant);
      }
      plant.box.alpha = focus && focus !== project.id ? 0 : 1;
      plant.name.visible = projects.length > 1 && !focus;
      plant.name.text = project.name;
      plant.name.scale.set(1);
      plant.name.scale.set(Math.min(1, 36 / Math.max(1, plant.name.height)));
      plant.selectionRing.visible = selection?.id === project.id;
      plant.lantern.visible =
        project.bugs.some((b) => ["failed", "attention"].includes(b.status)) ||
        project.goals.some((g) => g.state === "blocked");
      const visible = visibleFiles(
        project,
        prefs,
        now,
        focus === project.id,
        selection,
      );
      const visibleIds = new Set(visible.files.map((f) => f.id));
      for (const id of plant.slots.keys())
        if (!visibleIds.has(id)) {
          plant.slots.delete(id);
          plant.anchors.delete(id);
          plant.versions.delete(id);
        }
      for (const [id, item] of plant.leaves)
        if (!visibleIds.has(id)) {
          item.destroy({ children: true });
          plant.leaves.delete(id);
        }
      for (const file of visible.files) {
        let slot = plant.slots.get(file.id);
        if (slot === undefined) {
          slot = hash(file.id) % 80;
          const used = new Set(plant.slots.values());
          while (used.has(slot) && used.size < 80) slot = (slot + 1) % 80;
          plant.slots.set(file.id, slot);
        }
        const angle = slot * 2.399963;
        const radius =
          (plant.hero ? 42 : 32) +
          Math.sqrt(slot / 80) * (plant.hero ? 70 : 57);
        const x = Math.cos(angle) * radius;
        const y = (plant.hero ? -170 : -105) + Math.sin(angle) * radius * 0.9;
        plant.anchors.set(file.id, { x, y });
        let item = plant.leaves.get(file.id);
        const version = `${file.operation}:${file.external}:${file.touchedAt > 0}`;
        if (item && plant.versions.get(file.id) !== version) {
          item.destroy({ children: true });
          plant.leaves.delete(file.id);
          item = undefined;
        }
        if (!item) {
          item = new Container();
          item.position.set(x, y);
          plant.foliage.addChild(item);
          g(item)
            .moveTo(0, 0)
            .lineTo(-x * 0.4, 20)
            .stroke({ color: 0x6f8557, width: 1, alpha: 0.5 });
          leaf(
            item,
            0,
            0,
            x < 0 ? -0.7 : 0.7,
            0.65,
            file.external
              ? 0xc1a4df
              : file.operation === "delete"
                ? 0xd5b07f
                : file.operation === "edit"
                  ? 0xc2d982
                  : 0x76cfb0,
          );
          if (file.operation === "edit" && file.touchedAt > 0)
            flower(item, -5, -13, hash(file.id), 0.45);
          const hit = g(item)
            .circle(0, -10, 18)
            .fill({ color: 0xffffff, alpha: 0 });
          hit.eventMode = "static";
          hit.cursor = "pointer";
          hit.on("pointertap", (e) => {
            e.stopPropagation();
            this.select({ kind: "file", id: file.id });
          });
          plant.leaves.set(file.id, item);
          plant.versions.set(file.id, version);
        }
        const previous = plant.pulses.get(file.id);
        if (previous && previous.at !== file.touchedAt) {
          previous.ring.destroy();
          plant.pulses.delete(file.id);
        }
        if (
          file.touchedAt > 0 &&
          now - file.touchedAt < 2500 &&
          !plant.pulses.has(file.id) &&
          !reduced &&
          !prefs.freeze &&
          plant.pulses.size < 3
        ) {
          const ring = g(item)
            .circle(-5, -13, 15)
            .stroke({ color: 0xe1e7ad, width: 1.5, alpha: 0.7 });
          plant.pulses.set(file.id, { ring, at: file.touchedAt });
        }
        item.scale.set(
          leafScale(
            file,
            now,
            prefs.pins.includes(file.id) || selection?.id === file.id,
          ),
        );
        item.alpha = file.activeActors.length ? 1 : 0.78;
        if (selection?.id === file.id) item.alpha = 1;
      }
      const shown = [...project.bugs]
        .sort(
          (a, b) =>
            Number(b.id === selection?.id) - Number(a.id === selection?.id) ||
            Number(["failed", "attention"].includes(b.status)) -
              Number(["failed", "attention"].includes(a.status)) ||
            Number(b.status === "working") - Number(a.status === "working"),
        )
        .slice(0, Math.min(12, remainingBugs));
      remainingBugs -= shown.length;
      shown.forEach((b) => shownBugIds.add(b.id));
      for (const id of plant.bugSlots.keys())
        if (!shown.some((bug) => bug.id === id)) plant.bugSlots.delete(id);
      for (const bug of shown) {
        let v = this.bugs.get(bug.id);
        if (v && v.bug.role !== bug.role) {
          v.box.destroy({ children: true });
          this.bugs.delete(bug.id);
          v = undefined;
        }
        let homeSlot = plant.bugSlots.get(bug.id);
        if (homeSlot === undefined) {
          const occupied = new Set(plant.bugSlots.values());
          homeSlot = 0;
          while (occupied.has(homeSlot)) homeSlot++;
          plant.bugSlots.set(bug.id, homeSlot);
        }
        const home = helperHome(homeSlot, plant.box);
        const anchor = bug.fileId ? plant.anchors.get(bug.fileId) : undefined;
        const file =
          anchor && bug.status === "working"
            ? {
                x: plant.box.x + anchor.x + ((hash(bug.id) % 3) - 1) * 18,
                y: plant.box.y + anchor.y - 8 + (hash(bug.id) % 3) * 8,
              }
            : null;
        const activity = activityOf(bug.status, bug.operation);
        if (!v) {
          const art = bugArt(bug);
          const box = new Container();
          this.inhabitants.addChild(box);
          box.addChild(art.body);
          box.scale.set(0.88);
          box.position.set(home.x, home.y);
          const marker = g(box);
          marker.position.set(0, -46);
          const hit = g(box)
            .circle(0, -5, 30)
            .fill({ color: 0xffffff, alpha: 0 });
          hit.eventMode = "static";
          hit.cursor = "pointer";
          hit.on("pointertap", () =>
            this.select({ kind: "actor", id: bug.id }),
          );
          v = {
            bug,
            box,
            art,
            x: home.x,
            y: home.y,
            phase: hash(bug.id) % 100,
            marker,
            settledAt: 0,
            home,
            anchored: !!anchor,
            plant,
            file,
            activity,
            route: [],
            dwell: 0,
            spot: "ground",
            step: 0,
            plan: "",
          };
          this.bugs.set(bug.id, v);
        }
        if (v.bug.status === "working" && bug.status === "idle")
          v.settledAt = performance.now();
        v.bug = bug;
        v.home = home;
        v.anchored = !!anchor;
        v.plant = plant;
        v.file = file;
        v.activity = activity;
        // New work, or a new file: the current leg ends where it is and the
        // next one is planned for it.
        const plan = `${activity}|${file ? bug.fileId : ""}`;
        if (v.plan !== plan) {
          v.plan = plan;
          v.route = [];
          v.dwell = 0;
          v.step = 0;
        }
        v.box.alpha = focus && focus !== project.id ? 0 : 1;
        if (
          (bug.native || bug.parentId) &&
          bug.status === "idle" &&
          bug.lastActiveAt
        )
          v.box.alpha *= Math.max(
            0,
            Math.min(1, (12_000 - (now - bug.lastSeen)) / 2500),
          );
        v.marker.clear();
        if (bug.status === "waiting") {
          v.marker.circle(0, 0, 7).stroke({ color: 0xc8d8bf, width: 1.5 });
          v.marker
            .moveTo(0, -4)
            .lineTo(0, 0)
            .lineTo(3, 2)
            .stroke({ color: 0xc8d8bf, width: 1.5 });
        } else if (["failed", "attention"].includes(bug.status)) {
          v.marker.circle(0, 0, 11).fill({ color: 0xe9bf81, alpha: 0.12 });
          v.marker.roundRect(-4, -5, 8, 10, 2).fill(0xe9bf81);
        } else if (bug.status === "unknown") {
          v.marker
            .circle(0, 0, 5)
            .stroke({ color: 0xc8d8bf, width: 1, alpha: 0.5 });
        }
        if (reduced || prefs.freeze) {
          // Still scenery: the helper sits where its work is.
          const still = file ?? home;
          v.x = still.x;
          v.y = still.y;
          v.route = [];
          v.box.position.set(v.x, v.y);
          v.art.lens.visible = activity === "reading";
          v.art.tool.visible = activity === "editing" && !!file;
          v.art.bench.visible = activity === "running";
          v.art.thought.visible = activity === "thinking";
        }
      }
      const verified = project.goals.reduce((n, g) => n + g.verified, 0);
      const decorationKey = `${verified}:${visible.clustered}:${project.bugs.length - shown.length}`;
      if (plant.decorationKey !== decorationKey) {
        plant.decorationKey = decorationKey;
        plant.flowerLayer
          .removeChildren()
          .forEach((c) => c.destroy({ children: true }));
        for (let i = 0; i < Math.min(verified, 8); i++)
          flower(plant.flowerLayer, -45 + i * 12, 17 + Math.sin(i) * 3, i, 0.5);
        if (visible.clustered) {
          for (
            let i = 0;
            i < Math.min(5, Math.ceil(Math.log2(visible.clustered + 1)));
            i++
          )
            leaf(plant.flowerLayer, -30 + i * 12, 27, 0.5, 0.22, 0x94ad78);
        }
        if (project.bugs.length > shown.length) {
          // A small resting nest signals additional real helpers without text.
          ellipse(plant.flowerLayer, 51, 18, 16, 7, 0x9d8a61, 0.75);
          for (
            let i = 0;
            i < Math.min(4, project.bugs.length - shown.length);
            i++
          )
            ellipse(plant.flowerLayer, 42 + i * 6, 15, 2.5, 3.5, 0xb9c898);
        }
      }
    }
    for (const [id, v] of this.bugs)
      if (!shownBugIds.has(id)) {
        v.box.destroy({ children: true });
        this.bugs.delete(id);
      }
    this.garden.children.sort((a, b) =>
      a === this.inhabitants ? 1 : b === this.inhabitants ? -1 : a.y - b.y,
    );
    const focused = focus ? this.plants.get(focus) : undefined;
    const camera = focused
      ? focusCamera(focused.box.x, focused.box.y, focused.hero)
      : { zoom: 1, x: 0, y: 0 };
    this.toZoom = camera.zoom;
    this.toCameraX = camera.x;
    this.toCameraY = camera.y;
    if (reduced || prefs.freeze) {
      this.zoom = this.toZoom;
      this.cameraX = this.toCameraX;
      this.cameraY = this.toCameraY;
      this.garden.scale.set(this.zoom);
      this.garden.position.set(this.cameraX, this.cameraY);
    }
    this.syncTicker();
    if (!this.hidden) this.app.render();
  }
  private syncTicker() {
    if (this.hidden || this.prefs.freeze || this.reduced)
      this.app.ticker.stop();
    else this.app.ticker.start();
  }
  private tick = () => {
    const now = performance.now(),
      dt = Math.min((now - this.last || 16) / 1000, 0.05);
    this.last = now;
    this.clock += dt;
    this.zoom += (this.toZoom - this.zoom) * Math.min(1, dt * 4);
    this.cameraX += (this.toCameraX - this.cameraX) * Math.min(1, dt * 4);
    this.cameraY += (this.toCameraY - this.cameraY) * Math.min(1, dt * 4);
    this.garden.scale.set(this.zoom);
    this.garden.position.set(this.cameraX, this.cameraY);
    const sway = (id: string) => Math.sin(this.clock * 0.6 + (hash(id) % 10)) * 0.024 + Math.sin(this.clock * 1.3 + (hash(id) % 7)) * 0.008;
    for (const v of this.bugs.values()) {
      const work = v.bug.status === "working" || v.bug.status === "starting";
      const box = v.plant.box;
      if (v.route.length === 0 && v.dwell <= 0) {
        const tree = {
          trunkX: box.x,
          baseY: box.y - 12,
          perches: v.plant.perches.map((p) => ({ x: box.x + p.x, y: box.y + p.y - 8 })),
        };
        const leg = planLeg(v.activity, { x: v.x, y: v.y }, v.home, tree, v.file, hash(v.bug.id), v.step);
        v.route = leg.path;
        v.dwell = leg.dwell;
        v.spot = leg.spot;
        v.step += 1;
      }
      let walking = false;
      let climbing = false;
      if (v.route.length > 0) {
        const next = v.route[0]!;
        const distance = Math.hypot(next.x - v.x, next.y - v.y);
        const stride = speedFor({ x: v.x, y: v.y }, next) * dt;
        climbing = Math.abs(next.y - v.y) > Math.abs(next.x - v.x);
        if (distance <= stride) {
          v.x = next.x;
          v.y = next.y;
          v.route.shift();
        } else {
          v.x += ((next.x - v.x) / distance) * stride;
          v.y += ((next.y - v.y) / distance) * stride;
        }
        walking = true;
      } else v.dwell -= dt;
      const t = this.clock + v.phase;
      const settled = !walking;
      v.art.lens.visible = v.activity === "reading";
      v.art.tool.visible = v.activity === "editing" && settled && v.spot === "file";
      v.art.bench.visible = v.activity === "running" && settled && v.spot === "desk";
      v.art.thought.visible = v.activity === "thinking" || (v.activity === "running" && !v.art.bench.visible && settled);
      v.art.thought.children.forEach((dot, i) => {
        dot.alpha = 0.35 + (Math.sin(t * 3 - i) + 1) * 0.325;
      });
      // Up in the plant, a helper sways with it.
      const lean = v.y < box.y - 18 ? -(v.y - box.y) * sway(box.label) : 0;
      const bob = walking
        ? Math.sin(t * 12) * 1.4
        : work
          ? Math.sin(t * 4) * 2.2
          : Math.sin(t * 1.2) * 0.5;
      v.box.position.set(v.x + lean, v.y + bob);
      v.art.body.rotation = climbing
        ? Math.sin(t * 10) * 0.14
        : walking
        ? Math.sin(t * 8) * 0.06
        : work
          ? Math.sin(t * 3) * 0.07
          : Math.sin(t) * 0.015;
      v.art.body.rotation +=
        now - v.settledAt < 1500
          ? Math.sin((now - v.settledAt) / 140) * 0.08
          : 0;
      v.art.eyes.scale.y =
        v.bug.status === "idle" ? 0.12 : Math.sin(t * 0.7) > 0.995 ? 0.12 : 1;
      v.art.lens.rotation = Math.sin(t * 2) * 0.18;
      v.art.tool.rotation = Math.sin(t * 5) * 0.3;
      v.art.body.scale.y = 1 + Math.sin(t * 2) * 0.025;
      v.art.antennae.rotation = Math.sin(t * 1.5) * 0.035;
      v.art.halo.alpha =
        v.bug.id === this.current?.id
          ? 0.8
          : work
            ? 0.25 + Math.sin(t * 2) * 0.12
            : 0.1;
      v.art.wings.forEach((wing, i) => {
        wing.scale.x = 1 + Math.sin(t * (work ? 16 : 2) + i) * 0.18;
      });
      v.art.legs.forEach((leg, i) => {
        leg.rotation = walking
          ? Math.sin(t * 12 + i) * 0.14
          : work
            ? Math.sin(t * 4 + i) * 0.1
            : 0;
      });
    }
    for (const [id, p] of this.plants) {
      for (const [fileId, pulse] of p.pulses) {
        const age = (Date.now() - pulse.at) / 2500;
        if (age > 1 || pulse.ring.destroyed) {
          if (!pulse.ring.destroyed) pulse.ring.destroy();
          p.pulses.delete(fileId);
        } else {
          pulse.ring.scale.set(1 + age * 0.6);
          pulse.ring.alpha = 1 - age;
        }
      }
      p.foliage.rotation = sway(id);
      if (!this.prefs.economy) {
        // Each leaf flutters on its own beat; file leaves too.
        for (const leaf of p.flutter)
          leaf.item.rotation = leaf.base + Math.sin(this.clock * 1.7 + leaf.phase) * 0.07 + Math.sin(this.clock * 3.1 + leaf.phase * 2) * 0.02;
        let i = 0;
        for (const item of p.leaves.values())
          item.rotation = Math.sin(this.clock * 1.5 + (hash(id) % 5) + i++ * 0.9) * 0.06;
      }
    }
    if (!this.prefs.economy)
      for (const m of this.motes) {
        m.box.position.set(
          Math.sin(this.clock * 0.3 + m.phase) * 10,
          Math.sin(this.clock * 0.45 + m.phase) * 8,
        );
        m.box.alpha = 0.35 + Math.sin(this.clock + m.phase) * 0.25;
      }
  };
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.app.ticker.remove(this.tick);
    this.app.destroy(true, {
      children: true,
      texture: true,
      textureSource: true,
    });
  }
}
