'use client';

import { Suspense, useEffect, useRef, useState, useCallback } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/supabase-browser';
import './canvas.css';

interface CanvasObject {
  id: number;
  type: 'image' | 'text' | 'shape' | 'drawing' | 'markup' | 'swatch';
  x: number;
  y: number;
  w: number;
  h: number;
  content?: string;
  zIndex: number;
  textStyle?: 'title' | 'subtitle' | 'description';
  crop?: { x: number; y: number; w: number; h: number };
  points?: { x: number; y: number }[];
  strokeColor?: string;
  strokeWidth?: number;
  cloud?: { rx: number; ry: number; rw: number; rh: number };
  leader?: { tx: number; ty: number };
  markupText?: string;
}

async function uploadImage(
  file: File,
  projectId: string,
  supabase: any
): Promise<{ path: string; width: number; height: number } | null> {
  let imageFile = file;

  if (file.size > 2 * 1024 * 1024) {
    const resized = await resizeImage(file);
    if (!resized) return null;
    imageFile = resized;
  } else if (file.type !== 'image/jpeg') {
    const converted = await convertToJpeg(file);
    if (!converted) return null;
    imageFile = converted;
  }

  const dimensions = await getImageDimensions(imageFile);
  if (!dimensions) return null;
  const { width, height } = dimensions;

  const timestamp = Date.now();
  const path = `${projectId}/${timestamp}.jpg`;
  const { error } = await supabase.storage.from('project-assets').upload(path, imageFile, { upsert: false });

  if (error) return null;
  return { path, width, height };
}

async function resizeImage(file: File): Promise<File | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    img.onload = () => {
      let { width, height } = img;
      const maxSize = 1200;
      if (width > maxSize || height > maxSize) {
        const scale = Math.min(maxSize / width, maxSize / height);
        width *= scale;
        height *= scale;
      }
      canvas.width = width;
      canvas.height = height;
      ctx?.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(new File([blob], 'image.jpg', { type: 'image/jpeg' }));
          else resolve(null);
        },
        'image/jpeg',
        0.85
      );
    };

    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

async function convertToJpeg(file: File): Promise<File | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      if (ctx) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      }
      canvas.toBlob(
        (blob) => {
          if (blob) resolve(new File([blob], 'image.jpg', { type: 'image/jpeg' }));
          else resolve(null);
        },
        'image/jpeg',
        0.9
      );
    };

    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => resolve(null);
    img.src = URL.createObjectURL(file);
  });
}

function CanvasInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('project');

  const supabase = createClient();
  const [isLoaded, setIsLoaded] = useState(false);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const gridLayerRef = useRef<HTMLDivElement>(null);
  const samplerCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineInitialized = useRef(false);

  useEffect(() => {
    const checkAuth = async () => {
      const { data: { session } } = await supabase.auth.getSession();
      console.log('[canvas] auth check:', session ? 'logged in' : 'NOT logged in');
      if (!session) router.push('/');
    };
    checkAuth();
  }, []);

  useEffect(() => {
    if (!projectId) router.push('/');
  }, [projectId]);

  useEffect(() => {
    if (!projectId || !viewportRef.current || !worldRef.current) return;
    if (engineInitialized.current) return; // prevent double init
    engineInitialized.current = true;

    // Initialize the canvas engine as an IIFE
    (async () => {
      const viewport = viewportRef.current!;
      const world = worldRef.current!;
      const gridLayer = gridLayerRef.current!;
      const samplerCanvas = samplerCanvasRef.current!;

      const contextMenu = document.getElementById('contextMenu')!;
      const zoomIndicator = document.getElementById('zoomIndicator')!;
      const saveIndicator = document.getElementById('saveIndicator')!;
      const drawPreview = document.getElementById('drawPreview')!;
      const selectRect = document.getElementById('selectRect')!;

      let panX = 0, panY = 0, zoom = 1;
      let objects: CanvasObject[] = [];
      let nextId = 1;
      let selectedIds = new Set<number>();
      let spaceDown = false;
      let saveTimer: NodeJS.Timeout | null = null;

      function markDirty() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => saveProject(), 500);
      }

      let contextWorldX = 0, contextWorldY = 0;
      let activeTool: 'pointer' | 'rect' | 'markup' | 'draw' | 'eyedropper' = 'pointer';
      let cropState: { objId: number } | null = null;

      const markupBar = document.getElementById('markupBar')!;
      let markupBuild: {
        step: number;
        rx?: number;
        ry?: number;
        rw?: number;
        rh?: number;
        tx?: number;
        ty?: number;
      } | null = null;

      const drawBar = document.getElementById('drawBar')!;
      const drawColorInput = document.getElementById('drawColor') as HTMLInputElement;
      const drawSizeInput = document.getElementById('drawSize') as HTMLInputElement;
      const drawSizeDot = document.querySelector('.size-dot') as HTMLDivElement;
      let drawColor = '#F0C4A0';
      let drawSize = 4;

      drawColorInput.addEventListener('input', (e) => {
        drawColor = (e.target as HTMLInputElement).value;
      });
      drawSizeInput.addEventListener('input', (e) => {
        drawSize = parseInt((e.target as HTMLInputElement).value);
        drawSizeDot.style.width = drawSize + 'px';
        drawSizeDot.style.height = drawSize + 'px';
      });
      drawSizeDot.style.width = drawSize + 'px';
      drawSizeDot.style.height = drawSize + 'px';

      const eyedropperLoupe = document.getElementById('eyedropperLoupe')!;
      const loupeHex = document.querySelector('.loupe-hex') as HTMLDivElement;
      const eyedropperBar = document.getElementById('eyedropperBar')!;
      const eyedropperSwatch = document.querySelector('.swatch-preview') as HTMLDivElement;
      const eyedropperText = eyedropperBar.querySelector('span')!;
      const samplerCtx = samplerCanvas.getContext('2d', { willReadFrequently: true })!;
      let eyedropperColor: string | null = null;
      let eyedropperStep = 0;

      const GRID = 40;
      const SNAP_TOLERANCE = 8;
      const MAX_UNDO = 80;
      let undoStack: string[] = [];
      let redoStack: string[] = [];

      function pushUndo() {
        undoStack.push(JSON.stringify(objects));
        if (undoStack.length > MAX_UNDO) undoStack.shift();
        redoStack = [];
      }

      function undo() {
        if (undoStack.length === 0) return;
        redoStack.push(JSON.stringify(objects));
        objects = JSON.parse(undoStack.pop()!).map(normalizeObject);
        nextId = objects.length ? Math.max(...objects.map(o => o.id)) + 1 : 1;
        selectedIds.clear();
        renderObjects();
        markDirty();
      }

      function redo() {
        if (redoStack.length === 0) return;
        undoStack.push(JSON.stringify(objects));
        objects = JSON.parse(redoStack.pop()!).map(normalizeObject);
        nextId = objects.length ? Math.max(...objects.map(o => o.id)) + 1 : 1;
        selectedIds.clear();
        renderObjects();
        markDirty();
      }

      const OBJ_DEFAULTS = {
        id: 0, type: 'image' as const, x: 0, y: 0, w: 200, h: 150,
        content: '', zIndex: 1, textStyle: 'title' as const, crop: null,
        points: null, strokeColor: '#F0C4A0', strokeWidth: 4,
        cloud: null, leader: null, markupText: '',
      };

      function normalizeObject(obj: any): CanvasObject {
        const o = { ...OBJ_DEFAULTS, ...obj };
        o.x = Number(o.x) || 0;
        o.y = Number(o.y) || 0;
        o.w = Number(o.w) || 200;
        o.h = Number(o.h) || 150;
        o.zIndex = Number(o.zIndex) || 1;
        return o;
      }

      function applyTransform() {
        world.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
        const gs = GRID * zoom;
        gridLayer.style.backgroundSize = `${gs}px ${gs}px`;
        const bgX = (panX % gs) + (panX % gs < 0 ? gs : 0);
        const bgY = (panY % gs) + (panY % gs < 0 ? gs : 0);
        gridLayer.style.backgroundPosition = `${bgX}px ${bgY}px`;
        zoomIndicator.textContent = `${Math.round(zoom * 100)}%`;
      }

      function screenToWorld(sx: number, sy: number) {
        return { x: (sx - panX) / zoom, y: (sy - panY) / zoom };
      }

      function viewportCenter() {
        return screenToWorld((window.innerWidth - 52) / 2, window.innerHeight / 2);
      }

      function snapToGrid(val: number) {
        return Math.round(val / GRID) * GRID;
      }

      let activeGuides: HTMLElement[] = [];

      function clearGuides() {
        activeGuides.forEach(el => el.remove());
        activeGuides = [];
      }

      function getEdges(obj: CanvasObject) {
        return {
          left: obj.x, right: obj.x + obj.w,
          top: obj.y, bottom: obj.y + obj.h,
          cx: obj.x + obj.w / 2, cy: obj.y + obj.h / 2,
        };
      }

      function showGuide(axis: string, pos: number) {
        const g = document.createElement('div');
        g.className = 'snap-guide ' + (axis === 'x' ? 'vertical' : 'horizontal');
        if (axis === 'x') g.style.left = pos + 'px';
        else g.style.top = pos + 'px';
        world.appendChild(g);
        activeGuides.push(g);
      }

      function nearestGridLines(val: number) {
        const lo = Math.floor(val / GRID) * GRID;
        const hi = lo + GRID;
        return [lo, hi];
      }

      function snapObject(movingObj: CanvasObject) {
        clearGuides();
        const me = getEdges(movingObj);
        let snapX: { offset: number; guide: number } | null = null, snapY: { offset: number; guide: number } | null = null;
        let bestDx = SNAP_TOLERANCE + 1, bestDy = SNAP_TOLERANCE + 1;

        for (const other of objects) {
          if (other.id === movingObj.id || selectedIds.has(other.id)) continue;
          const oe = getEdges(other);
          for (const [mine, theirs] of [
            [me.left, oe.left], [me.left, oe.right],
            [me.right, oe.left], [me.right, oe.right],
            [me.cx, oe.cx],
          ] as [number, number][]) {
            const d = Math.abs(mine - theirs);
            if (d < bestDx) { bestDx = d; snapX = { offset: theirs - mine, guide: theirs }; }
          }
          for (const [mine, theirs] of [
            [me.top, oe.top], [me.top, oe.bottom],
            [me.bottom, oe.top], [me.bottom, oe.bottom],
            [me.cy, oe.cy],
          ] as [number, number][]) {
            const d = Math.abs(mine - theirs);
            if (d < bestDy) { bestDy = d; snapY = { offset: theirs - mine, guide: theirs }; }
          }
        }

        for (const edge of [me.left, me.right, me.cx]) {
          for (const gl of nearestGridLines(edge)) {
            const d = Math.abs(edge - gl);
            if (d < bestDx) { bestDx = d; snapX = { offset: gl - edge, guide: gl }; }
          }
        }
        for (const edge of [me.top, me.bottom, me.cy]) {
          for (const gl of nearestGridLines(edge)) {
            const d = Math.abs(edge - gl);
            if (d < bestDy) { bestDy = d; snapY = { offset: gl - edge, guide: gl }; }
          }
        }

        let fx = movingObj.x, fy = movingObj.y;
        if (snapX && bestDx <= SNAP_TOLERANCE) { fx += snapX.offset; showGuide('x', snapX.guide); }
        if (snapY && bestDy <= SNAP_TOLERANCE) { fy += snapY.offset; showGuide('y', snapY.guide); }
        return { x: fx, y: fy };
      }

      function snapResize(obj: CanvasObject, handle: string) {
        clearGuides();
        let { x, y, w, h } = obj;
        let bestDx = SNAP_TOLERANCE + 1, bestDy = SNAP_TOLERANCE + 1;
        let sxOff: number | null = null, syOff: number | null = null;
        const rR = handle.includes('r'), rL = handle.includes('l');
        const rB = handle.includes('b'), rT = handle.includes('t');
        const myX = rR ? x + w : x;
        const myY = rB ? y + h : y;

        for (const other of objects) {
          if (other.id === obj.id) continue;
          const oe = getEdges(other);
          if (rR || rL) for (const e of [oe.left, oe.right]) {
            const d = Math.abs(myX - e); if (d < bestDx) { bestDx = d; sxOff = e; }
          }
          if (rB || rT) for (const e of [oe.top, oe.bottom]) {
            const d = Math.abs(myY - e); if (d < bestDy) { bestDy = d; syOff = e; }
          }
        }

        if (rR || rL) for (const gl of nearestGridLines(myX)) {
          const d = Math.abs(myX - gl); if (d < bestDx) { bestDx = d; sxOff = gl; }
        }
        if (rB || rT) for (const gl of nearestGridLines(myY)) {
          const d = Math.abs(myY - gl); if (d < bestDy) { bestDy = d; syOff = gl; }
        }

        if (sxOff !== null && bestDx <= SNAP_TOLERANCE) {
          if (rR) w = sxOff - x;
          else if (rL) { const oR = x + w; x = sxOff; w = oR - x; }
          showGuide('x', sxOff);
        }
        if (syOff !== null && bestDy <= SNAP_TOLERANCE) {
          if (rB) h = syOff - y;
          else if (rT) { const oB = y + h; y = syOff; h = oB - y; }
          showGuide('y', syOff);
        }
        return { x, y, w: Math.max(40, w), h: Math.max(40, h) };
      }

      function selectObject(id: number | null, additive?: boolean) {
        if (cropState) closeCrop();
        if (id === null) { selectedIds.clear(); }
        else if (additive) {
          if (selectedIds.has(id)) selectedIds.delete(id);
          else selectedIds.add(id);
        } else {
          if (!selectedIds.has(id)) {
            selectedIds.clear();
            selectedIds.add(id);
          }
        }
        updateSelectionVisuals();
      }

      function updateSelectionVisuals() {
        world.querySelectorAll('.canvas-obj').forEach(el => {
          el.classList.toggle('selected', selectedIds.has(Number(el.dataset.id)));
        });
      }

      function renderObjects() {
        world.querySelectorAll('.canvas-obj').forEach(el => el.remove());
        const sorted = [...objects].sort((a, b) => a.zIndex - b.zIndex);

        sorted.forEach(obj => {
          const el = document.createElement('div');
          const isText = obj.type === 'text';
          const isShape = obj.type === 'shape';
          const styleCls = isText ? ` style-${obj.textStyle || 'title'}` : '';
          const shapeCls = isShape ? ' shape-obj' : '';
          el.className = `canvas-obj${isText ? ' text-obj' : ''}${styleCls}${shapeCls}`;
          el.dataset.id = String(obj.id);
          el.style.left = obj.x + 'px';
          el.style.top = obj.y + 'px';
          el.style.width = obj.w + 'px';
          if (isText) el.style.minHeight = obj.h + 'px';
          else el.style.height = obj.h + 'px';
          el.style.zIndex = String(obj.zIndex);

          if (selectedIds.has(obj.id)) el.classList.add('selected');

          if (obj.type === 'drawing' && obj.points && obj.points.length > 1) {
            el.classList.add('drawing-obj');
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('viewBox', `0 0 ${obj.w} ${obj.h}`);
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            let d = `M ${obj.points[0].x} ${obj.points[0].y}`;
            for (let i = 1; i < obj.points.length; i++) {
              d += ` L ${obj.points[i].x} ${obj.points[i].y}`;
            }
            path.setAttribute('d', d);
            path.setAttribute('stroke', obj.strokeColor || '#F0C4A0');
            path.setAttribute('stroke-width', String(obj.strokeWidth || 4));
            path.setAttribute('fill', 'none');
            svg.appendChild(path);
            el.appendChild(svg);
          } else if (obj.type === 'markup' && obj.cloud && obj.leader) {
            el.classList.add('markup-obj');
            const c = obj.cloud;
            const l = obj.leader;

            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.style.left = '0'; svg.style.top = '0';
            svg.style.width = obj.w + 'px'; svg.style.height = obj.h + 'px';

            const arcR = 10;
            let cloudD = '';
            const cx1 = c.rx, cy1 = c.ry, cx2 = c.rx + c.rw, cy2 = c.ry + c.rh;

            for (let x = cx1; x < cx2; x += arcR * 2) {
              const end = Math.min(x + arcR * 2, cx2);
              cloudD += cloudD ? '' : `M ${cx1} ${cy1}`;
              cloudD += ` A ${arcR} ${arcR} 0 0 1 ${end} ${cy1}`;
            }
            for (let y = cy1; y < cy2; y += arcR * 2) {
              const end = Math.min(y + arcR * 2, cy2);
              cloudD += ` A ${arcR} ${arcR} 0 0 1 ${cx2} ${end}`;
            }
            for (let x = cx2; x > cx1; x -= arcR * 2) {
              const end = Math.max(x - arcR * 2, cx1);
              cloudD += ` A ${arcR} ${arcR} 0 0 1 ${end} ${cy2}`;
            }
            for (let y = cy2; y > cy1; y -= arcR * 2) {
              const end = Math.max(y - arcR * 2, cy1);
              cloudD += ` A ${arcR} ${arcR} 0 0 1 ${cx1} ${end}`;
            }
            cloudD += ' Z';

            const cloudPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            cloudPath.setAttribute('d', cloudD);
            cloudPath.setAttribute('stroke', '#ff4444');
            cloudPath.setAttribute('stroke-width', '2');
            cloudPath.setAttribute('fill', 'none');
            svg.appendChild(cloudPath);

            const cloudCx = c.rx + c.rw / 2, cloudCy = c.ry + c.rh / 2;
            const tx = l.tx, ty = l.ty;
            const textAnchor = { x: tx, y: ty + 20 };

            const dx = textAnchor.x - cloudCx, dy = textAnchor.y - cloudCy;
            let arrowEnd;
            const GAP = 14;
            if (Math.abs(dx) === 0 && Math.abs(dy) === 0) {
              arrowEnd = { x: cloudCx, y: cy1 - GAP };
            } else {
              const scaleX = dx !== 0 ? (c.rw / 2) / Math.abs(dx) : Infinity;
              const scaleY = dy !== 0 ? (c.rh / 2) / Math.abs(dy) : Infinity;
              const s = Math.min(scaleX, scaleY);
              const edgeX = cloudCx + dx * s, edgeY = cloudCy + dy * s;
              const toDist = Math.hypot(dx, dy);
              arrowEnd = {
                x: edgeX + (dx / toDist) * GAP,
                y: edgeY + (dy / toDist) * GAP,
              };
            }

            const mx = (textAnchor.x + arrowEnd.x) / 2, my = (textAnchor.y + arrowEnd.y) / 2;
            const dist = Math.hypot(arrowEnd.x - textAnchor.x, arrowEnd.y - textAnchor.y) || 1;
            const perpX = -(arrowEnd.y - textAnchor.y) / dist, perpY = (arrowEnd.x - textAnchor.x) / dist;
            const curvature = Math.min(dist * 0.25, 60);
            const cpx = mx + perpX * curvature, cpy = my + perpY * curvature;

            const curve = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            curve.setAttribute('d', `M ${textAnchor.x} ${textAnchor.y} Q ${cpx} ${cpy} ${arrowEnd.x} ${arrowEnd.y}`);
            curve.setAttribute('stroke', '#ff4444');
            curve.setAttribute('stroke-width', '2');
            curve.setAttribute('fill', 'none');
            svg.appendChild(curve);

            const angle = Math.atan2(arrowEnd.y - cpy, arrowEnd.x - cpx);
            const aLen = 12, aSpread = 0.35;
            const ah1x = arrowEnd.x - aLen * Math.cos(angle - aSpread);
            const ah1y = arrowEnd.y - aLen * Math.sin(angle - aSpread);
            const ah2x = arrowEnd.x - aLen * Math.cos(angle + aSpread);
            const ah2y = arrowEnd.y - aLen * Math.sin(angle + aSpread);
            const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            arrow.setAttribute('d', `M ${ah1x} ${ah1y} L ${arrowEnd.x} ${arrowEnd.y} L ${ah2x} ${ah2y} Z`);
            arrow.setAttribute('stroke', '#ff4444');
            arrow.setAttribute('stroke-width', '1.5');
            arrow.setAttribute('fill', '#ff4444');
            svg.appendChild(arrow);

            el.appendChild(svg);

            const textDiv = document.createElement('div');
            textDiv.className = 'markup-text';
            textDiv.style.top = ty + 'px';
            textDiv.style.width = 'max-content';
            textDiv.style.maxWidth = '250px';
            const textIsLeft = tx < cloudCx;
            if (textIsLeft) {
              textDiv.style.left = tx + 'px';
              textDiv.style.transform = 'translateX(-100%)';
              textDiv.style.textAlign = 'right';
            } else {
              textDiv.style.left = tx + 'px';
              textDiv.style.textAlign = 'left';
            }
            textDiv.textContent = obj.markupText || 'Note';
            el.appendChild(textDiv);
          } else if (obj.type === 'swatch') {
            el.classList.add('swatch-obj');
            const hex = (obj.content || '#888888').toUpperCase();
            el.style.background = hex;
            el.style.borderRadius = '50%';

            const label = document.createElement('span');
            label.className = 'swatch-label';
            label.textContent = hex;
            const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
            const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            if (luminance > 0.55) label.classList.add('dark-text');
            label.addEventListener('click', (ev) => {
              ev.stopPropagation();
              navigator.clipboard.writeText(hex).then(() => {
                label.textContent = 'Copied!';
                label.classList.add('copied');
                setTimeout(() => {
                  label.textContent = hex;
                  label.classList.remove('copied');
                }, 1200);
              });
            });
            el.appendChild(label);
          } else if (obj.type === 'image') {
            const wrapper = document.createElement('div');
            wrapper.className = 'img-wrapper';
            const img = document.createElement('img');
            img.crossOrigin = 'anonymous';
            const { data } = supabase.storage.from('project-assets').getPublicUrl(obj.content);
            img.src = data.publicUrl;
            img.draggable = false;
            if (obj.crop) {
              img.className = 'cropped';
              const sx = 100 / obj.crop.w, sy = 100 / obj.crop.h;
              img.style.width = (sx * 100) + '%';
              img.style.height = (sy * 100) + '%';
              img.style.left = -(obj.crop.x * sx) + '%';
              img.style.top = -(obj.crop.y * sy) + '%';
            } else {
              img.className = 'uncropped';
            }
            wrapper.appendChild(img);
            el.appendChild(wrapper);
          } else if (obj.type === 'text') {
            if (obj.content) {
              el.textContent = obj.content;
            } else {
              const ph = { title: 'Title', subtitle: 'Subtitle', description: 'Description' };
              const span = document.createElement('span');
              span.className = 'placeholder-text';
              span.textContent = ph[obj.textStyle || 'title'] || 'Text';
              el.appendChild(span);
            }
          }

          ['tl', 'tr', 'bl', 'br'].forEach(pos => {
            const h = document.createElement('div');
            h.className = `resize-handle rh-${pos}`;
            h.dataset.handle = pos;
            el.appendChild(h);
          });

          world.appendChild(el);
        });
      }

      function startPan(e: MouseEvent) {
        viewport.classList.add('panning');
        const sx = e.clientX, sy = e.clientY;
        const spx = panX, spy = panY;
        function onMove(ev: MouseEvent) {
          panX = spx + (ev.clientX - sx);
          panY = spy + (ev.clientY - sy);
          applyTransform();
        }
        function onUp(ev: MouseEvent) {
          viewport.classList.remove('panning');
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (ev.button === 2) {
            if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) showContextMenu(ev);
          }
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }

      viewport.addEventListener('contextmenu', (e) => e.preventDefault());

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button === 2 && e.ctrlKey) {
          e.preventDefault();
          const sy = e.clientY, sz = zoom;
          const cx = (window.innerWidth - 52) / 2, cy = window.innerHeight / 2;
          const wx = (cx - panX) / zoom, wy = (cy - panY) / zoom;
          function onMove(ev: MouseEvent) {
            zoom = Math.min(5, Math.max(0.1, sz * Math.pow(2, -(ev.clientY - sy) / 200)));
            panX = cx - wx * zoom; panY = cy - wy * zoom;
            applyTransform();
          }
          function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          return;
        }
        if (e.button === 2) { e.preventDefault(); startPan(e); return; }
        if (e.button === 0 && spaceDown) { e.preventDefault(); startPan(e); return; }
        if (e.button === 1) { e.preventDefault(); startPan(e); return; }
      });

      viewport.addEventListener('wheel', (e: WheelEvent) => {
        e.preventDefault();
        const nz = Math.min(5, Math.max(0.1, zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
        const wx = (e.clientX - panX) / zoom, wy = (e.clientY - panY) / zoom;
        zoom = nz; panX = e.clientX - wx * zoom; panY = e.clientY - wy * zoom;
        applyTransform();
      }, { passive: false });

      function sampleColorAtScreen(sx: number, sy: number): string {
        const vw = window.innerWidth - 52, vh = window.innerHeight;
        samplerCanvas.width = vw;
        samplerCanvas.height = vh;
        samplerCtx.clearRect(0, 0, vw, vh);
        samplerCtx.fillStyle = '#1a1a1a';
        samplerCtx.fillRect(0, 0, vw, vh);

        const sorted = [...objects].sort((a, b) => a.zIndex - b.zIndex);
        for (const obj of sorted) {
          if (obj.type === 'image') {
            const imgEl = world.querySelector(`[data-id="${obj.id}"] img`) as HTMLImageElement;
            if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) continue;
            const screenX = obj.x * zoom + panX;
            const screenY = obj.y * zoom + panY;
            const screenW = obj.w * zoom;
            const screenH = obj.h * zoom;
            try {
              if (obj.crop) {
                const sx2 = obj.crop.x / 100 * imgEl.naturalWidth;
                const sy2 = obj.crop.y / 100 * imgEl.naturalHeight;
                const sw2 = obj.crop.w / 100 * imgEl.naturalWidth;
                const sh2 = obj.crop.h / 100 * imgEl.naturalHeight;
                samplerCtx.drawImage(imgEl, sx2, sy2, sw2, sh2, screenX, screenY, screenW, screenH);
              } else {
                samplerCtx.drawImage(imgEl, 0, 0, imgEl.naturalWidth, imgEl.naturalHeight, screenX, screenY, screenW, screenH);
              }
            } catch(_) {}
          } else if (obj.type === 'swatch') {
            const screenX = obj.x * zoom + panX;
            const screenY = obj.y * zoom + panY;
            const screenW = obj.w * zoom;
            const screenH = obj.h * zoom;
            samplerCtx.fillStyle = obj.content || '#888';
            samplerCtx.beginPath();
            samplerCtx.ellipse(screenX + screenW/2, screenY + screenH/2, screenW/2, screenH/2, 0, 0, Math.PI * 2);
            samplerCtx.fill();
          } else if (obj.type === 'shape') {
            const screenX = obj.x * zoom + panX;
            const screenY = obj.y * zoom + panY;
            const screenW = obj.w * zoom;
            const screenH = obj.h * zoom;
            samplerCtx.fillStyle = '#F0C4A0';
            samplerCtx.fillRect(screenX, screenY, screenW, screenH);
          }
        }

        const px = Math.round(sx), py = Math.round(sy);
        if (px < 0 || py < 0 || px >= vw || py >= vh) return '#1a1a1a';
        try {
          const data = samplerCtx.getImageData(px, py, 1, 1).data;
          return '#' + ((1 << 24) + (data[0] << 16) + (data[1] << 8) + data[2]).toString(16).slice(1);
        } catch(_) {
          return '#1a1a1a';
        }
      }

      viewport.addEventListener('mousemove', (e: MouseEvent) => {
        if (activeTool !== 'eyedropper' || eyedropperStep !== 1) return;
        const color = sampleColorAtScreen(e.clientX, e.clientY);
        eyedropperLoupe.classList.add('visible');
        eyedropperLoupe.style.left = e.clientX + 'px';
        eyedropperLoupe.style.top = e.clientY + 'px';
        eyedropperLoupe.style.background = color;
        loupeHex.textContent = color.toUpperCase();
      });

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0 || activeTool !== 'eyedropper' || spaceDown) return;
        e.preventDefault(); e.stopPropagation();

        if (eyedropperStep === 1) {
          const color = sampleColorAtScreen(e.clientX, e.clientY);
          eyedropperColor = color;
          eyedropperStep = 2;
          eyedropperLoupe.classList.remove('visible');
          eyedropperSwatch.style.background = color;
          eyedropperText.textContent = `${color.toUpperCase()} — Click to place swatch`;
          return;
        }

        if (eyedropperStep === 2) {
          const w = screenToWorld(e.clientX, e.clientY);
          const size = 60;
          pushUndo();
          const id = nextId++;
          const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
          objects.push(normalizeObject({
            id, type: 'swatch',
            x: w.x - size / 2, y: w.y - size / 2,
            w: size, h: size,
            content: eyedropperColor!,
            zIndex: mz,
          }));
          selectObject(id);
          renderObjects();
          markDirty();
          setTool('pointer');
          return;
        }
      }, true);

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0 || activeTool !== 'rect' || spaceDown) return;
        if ((e.target as HTMLElement).closest('.resize-handle')) return;
        e.preventDefault(); e.stopPropagation();
        selectObject(null);
        const sw = screenToWorld(e.clientX, e.clientY);
        drawPreview.style.display = 'block';

        function onMove(ev: MouseEvent) {
          const c = screenToWorld(ev.clientX, ev.clientY);
          const rx = Math.min(sw.x, c.x), ry = Math.min(sw.y, c.y);
          drawPreview.style.left = rx + 'px'; drawPreview.style.top = ry + 'px';
          drawPreview.style.width = Math.abs(c.x - sw.x) + 'px';
          drawPreview.style.height = Math.abs(c.y - sw.y) + 'px';
        }
        function onUp(ev: MouseEvent) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          drawPreview.style.display = 'none';
          const ew = screenToWorld(ev.clientX, ev.clientY);
          const rw = Math.abs(ew.x - sw.x), rh = Math.abs(ew.y - sw.y);
          if (rw > 10 && rh > 10) {
            pushUndo();
            const id = nextId++;
            const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
            objects.push(normalizeObject({
              id, type: 'shape',
              x: Math.min(sw.x, ew.x), y: Math.min(sw.y, ew.y),
              w: rw, h: rh, content: '', zIndex: mz,
            }));
            selectObject(id); renderObjects(); markDirty();
          }
          setTool('pointer');
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }, true);

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0 || activeTool !== 'markup' || spaceDown) return;
        if ((e.target as HTMLElement).closest('.resize-handle')) return;

        if (!markupBuild || markupBuild.step === 1) {
          e.preventDefault(); e.stopPropagation();
          selectObject(null);
          markupBuild = { step: 1 };

          const sw = screenToWorld(e.clientX, e.clientY);
          drawPreview.style.display = 'block';
          drawPreview.style.border = '2px dashed #ff4444';
          drawPreview.style.background = 'rgba(255,68,68,0.05)';

          function onMove(ev: MouseEvent) {
            const c = screenToWorld(ev.clientX, ev.clientY);
            drawPreview.style.left = Math.min(sw.x, c.x) + 'px';
            drawPreview.style.top = Math.min(sw.y, c.y) + 'px';
            drawPreview.style.width = Math.abs(c.x - sw.x) + 'px';
            drawPreview.style.height = Math.abs(c.y - sw.y) + 'px';
          }
          function onUp(ev: MouseEvent) {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            drawPreview.style.display = 'none';
            drawPreview.style.border = '2px dashed var(--peach)';
            drawPreview.style.background = 'rgba(240,196,160,0.06)';

            const ew = screenToWorld(ev.clientX, ev.clientY);
            const rw = Math.abs(ew.x - sw.x), rh = Math.abs(ew.y - sw.y);
            if (rw < 10 || rh < 10) { markupBuild = null; return; }

            markupBuild = {
              step: 2,
              rx: Math.min(sw.x, ew.x), ry: Math.min(sw.y, ew.y),
              rw, rh,
            };
            document.querySelector('.step-num')!.textContent = '2';
            document.querySelector('.step-num')!.nextElementSibling!.textContent = 'Click where to place the note';
          }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          return;
        }

        if (markupBuild && markupBuild.step === 2) {
          e.preventDefault(); e.stopPropagation();
          const tw = screenToWorld(e.clientX, e.clientY);
          markupBuild.tx = tw.x;
          markupBuild.ty = tw.y;
          markupBuild.step = 3;

          const PAD = 20;
          const allX = [markupBuild.rx!, markupBuild.rx! + markupBuild.rw!, tw.x, tw.x + 150];
          const allY = [markupBuild.ry!, markupBuild.ry! + markupBuild.rh!, tw.y, tw.y + 30];
          const bx = Math.min(...allX) - PAD;
          const by = Math.min(...allY) - PAD;
          const bx2 = Math.max(...allX) + PAD;
          const by2 = Math.max(...allY) + PAD;

          pushUndo();
          const id = nextId++;
          const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
          objects.push(normalizeObject({
            id, type: 'markup',
            x: bx, y: by, w: bx2 - bx, h: by2 - by,
            cloud: {
              rx: markupBuild.rx! - bx,
              ry: markupBuild.ry! - by,
              rw: markupBuild.rw!,
              rh: markupBuild.rh!,
            },
            leader: {
              tx: tw.x - bx,
              ty: tw.y - by,
            },
            markupText: '',
            content: '', zIndex: mz,
          }));

          selectObject(id);
          renderObjects();
          markDirty();

          setTimeout(() => {
            const textEl = world.querySelector(`[data-id="${id}"] .markup-text`) as HTMLElement;
            if (textEl) {
              textEl.contentEditable = 'true';
              textEl.textContent = '';
              textEl.focus();
              function onBlur() {
                textEl.contentEditable = 'false';
                const obj = objects.find(o => o.id === id);
                if (obj) obj.markupText = textEl.textContent!.trim() || 'Note';
                textEl.removeEventListener('blur', onBlur);
                renderObjects();
                markDirty();
              }
              textEl.addEventListener('blur', onBlur);
              textEl.addEventListener('keydown', (ev: KeyboardEvent) => {
                if (ev.key === 'Escape') textEl.blur();
              });
            }
          }, 50);

          markupBuild = null;
          document.querySelector('.step-num')!.textContent = '1';
          document.querySelector('.step-num')!.nextElementSibling!.textContent = 'Draw rectangle around area';
          return;
        }
      }, true);

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0 || activeTool !== 'draw' || spaceDown) return;
        if ((e.target as HTMLElement).closest('.resize-handle')) return;
        e.preventDefault(); e.stopPropagation();
        selectObject(null);

        const points: { x: number; y: number }[] = [];
        const sw = screenToWorld(e.clientX, e.clientY);
        points.push({ x: 0, y: 0 });
        let minX = sw.x, minY = sw.y, maxX = sw.x, maxY = sw.y;

        const previewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        previewSvg.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;overflow:visible;pointer-events:none;z-index:9999';
        const previewPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        previewPath.setAttribute('stroke', drawColor);
        previewPath.setAttribute('stroke-width', String(drawSize));
        previewPath.setAttribute('fill', 'none');
        previewPath.setAttribute('stroke-linecap', 'round');
        previewPath.setAttribute('stroke-linejoin', 'round');
        previewSvg.appendChild(previewPath);
        world.appendChild(previewSvg);

        function onMove(ev: MouseEvent) {
          const c = screenToWorld(ev.clientX, ev.clientY);
          points.push({ x: c.x - sw.x, y: c.y - sw.y });
          if (c.x < minX) minX = c.x; if (c.y < minY) minY = c.y;
          if (c.x > maxX) maxX = c.x; if (c.y > maxY) maxY = c.y;
          let d = `M ${sw.x} ${sw.y}`;
          for (let i = 1; i < points.length; i++) d += ` L ${sw.x + points[i].x} ${sw.y + points[i].y}`;
          previewPath.setAttribute('d', d);
        }

        function onUp() {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          previewSvg.remove();

          if (points.length < 2) return;
          pushUndo();

          const pad = drawSize;
          const bx = minX - pad, by = minY - pad;
          const bw = (maxX - minX) + pad * 2;
          const bh = (maxY - minY) + pad * 2;
          if (bw < 2 || bh < 2) return;

          const localPts = points.map(p => ({
            x: (sw.x + p.x) - bx,
            y: (sw.y + p.y) - by,
          }));

          const id = nextId++;
          const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
          objects.push(normalizeObject({
            id, type: 'drawing',
            x: bx, y: by, w: bw, h: bh,
            points: localPts,
            strokeColor: drawColor,
            strokeWidth: drawSize,
            content: '', zIndex: mz,
          }));
          selectObject(id); renderObjects(); markDirty();
        }

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }, true);

      viewport.addEventListener('mousedown', (e: MouseEvent) => {
        if (e.button !== 0 || spaceDown || activeTool !== 'pointer') return;

        const handle = (e.target as HTMLElement).closest('.resize-handle') as HTMLDivElement | null;
        const objEl = (e.target as HTMLElement).closest('.canvas-obj') as HTMLDivElement | null;

        if (cropState) {
          const cropEl = (e.target as HTMLElement).closest('.crop-rect, .crop-handle, .crop-actions');
          if (cropEl) return;
          if (!objEl || parseInt(objEl.dataset.id) !== cropState.objId) {
            closeCrop();
          }
        }

        const markupTextEl = (e.target as HTMLElement).closest('.markup-text');
        if (markupTextEl && objEl) {
          const id = parseInt(objEl.dataset.id);
          const obj = objects.find(o => o.id === id);
          if (obj && obj.type === 'markup' && obj.leader) {
            e.preventDefault(); e.stopPropagation();
            pushUndo();
            selectObject(id);
            const sx = e.clientX, sy = e.clientY;
            const origTx = obj.leader.tx, origTy = obj.leader.ty;

            function onMove(ev: MouseEvent) {
              const dx = (ev.clientX - sx) / zoom;
              const dy = (ev.clientY - sy) / zoom;
              obj.leader!.tx = origTx + dx;
              obj.leader!.ty = origTy + dy;

              const PAD = 20;
              const allX = [obj.cloud!.rx, obj.cloud!.rx + obj.cloud!.rw, obj.leader!.tx, obj.leader!.tx + 150];
              const allY = [obj.cloud!.ry, obj.cloud!.ry + obj.cloud!.rh, obj.leader!.ty, obj.leader!.ty + 30];
              const minX = Math.min(...allX) - PAD, minY = Math.min(...allY) - PAD;
              const maxX = Math.max(...allX) + PAD, maxY = Math.max(...allY) + PAD;
              const newW = maxX - minX, newH = maxY - minY;

              const shiftX = minX < 0 ? minX : 0;
              const shiftY = minY < 0 ? minY : 0;
              if (shiftX < 0 || shiftY < 0) {
                obj.x += shiftX;
                obj.y += shiftY;
                obj.cloud!.rx -= shiftX;
                obj.cloud!.ry -= shiftY;
                obj.leader!.tx -= shiftX;
                obj.leader!.ty -= shiftY;
              }
              obj.w = Math.max(obj.w, newW);
              obj.h = Math.max(obj.h, newH);

              renderObjects();
              markDirty();
            }
            function onUp() {
              const PAD = 20;
              const c = obj.cloud!, l = obj.leader!;
              const allX = [c.rx, c.rx + c.rw, l.tx, l.tx + 150];
              const allY = [c.ry, c.ry + c.rh, l.ty, l.ty + 30];
              const minX = Math.min(...allX) - PAD, minY = Math.min(...allY) - PAD;
              const maxX = Math.max(...allX) + PAD, maxY = Math.max(...allY) + PAD;
              obj.x += minX;
              obj.y += minY;
              obj.cloud!.rx -= minX;
              obj.cloud!.ry -= minY;
              obj.leader!.tx -= minX;
              obj.leader!.ty -= minY;
              obj.w = maxX - minX;
              obj.h = maxY - minY;
              renderObjects();
              document.removeEventListener('mousemove', onMove);
              document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            return;
          }
        }

        if (handle && objEl) {
          e.preventDefault(); e.stopPropagation();
          const id = parseInt(objEl.dataset.id);
          const obj = objects.find(o => o.id === id);
          if (!obj) return;
          pushUndo();
          selectObject(id);

          const sx = e.clientX, sy = e.clientY;
          const ox = obj.x, oy = obj.y, ow = obj.w, oh = obj.h;
          const hp = handle.dataset.handle!;
          const isImg = obj.type === 'image';
          const ar = ow / oh;

          function onMove(ev: MouseEvent) {
            const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
            let nx = ox, ny = oy, nw = ow, nh = oh;
            if (hp.includes('r')) nw = ow + dx;
            if (hp.includes('l')) { nx = ox + dx; nw = ow - dx; }
            if (hp.includes('b')) nh = oh + dy;
            if (hp.includes('t')) { ny = oy + dy; nh = oh - dy; }
            if (isImg || ev.shiftKey) {
              if (Math.abs(dx) > Math.abs(dy)) {
                nh = nw / ar; if (hp.includes('t')) ny = oy + oh - nh;
              } else {
                nw = nh * ar; if (hp.includes('l')) nx = ox + ow - nw;
              }
            }
            obj.x = nx; obj.y = ny; obj.w = nw; obj.h = nh;
            const s = snapResize(obj, hp);
            obj.x = s.x; obj.y = s.y; obj.w = s.w; obj.h = s.h;
            renderObjects(); markDirty();
          }
          function onUp() { clearGuides(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          return;
        }

        if (objEl) {
          if (objEl.getAttribute('contenteditable') === 'true') return;
          e.preventDefault();
          let id = parseInt(objEl.dataset.id);
          let obj = objects.find(o => o.id === id);
          if (!obj) return;

          if (e.shiftKey) { selectObject(id, true); return; }

          pushUndo();

          if (e.altKey) {
            const dupes = [];
            for (const sid of selectedIds) {
              const src = objects.find(o => o.id === sid);
              if (!src) continue;
              const cid = nextId++;
              dupes.push(normalizeObject({ ...JSON.parse(JSON.stringify(src)), id: cid, zIndex: Math.max(...objects.map(o=>o.zIndex),0)+1 }));
            }
            if (dupes.length === 0) {
              const cid = nextId++;
              dupes.push(normalizeObject({ ...JSON.parse(JSON.stringify(obj)), id: cid, zIndex: Math.max(...objects.map(o=>o.zIndex),0)+1 }));
            }
            objects.push(...dupes);
            selectedIds.clear();
            dupes.forEach(d => selectedIds.add(d.id));
            id = dupes[0].id;
            obj = objects.find(o => o.id === id)!;
            renderObjects();
          }

          if (!selectedIds.has(id)) selectObject(id);

          const sx = e.clientX, sy = e.clientY;
          const origins = new Map<number, { x: number; y: number }>();
          for (const sid of selectedIds) {
            const so = objects.find(o => o.id === sid);
            if (so) origins.set(sid, { x: so.x, y: so.y });
          }

          function onMove(ev: MouseEvent) {
            const dx = (ev.clientX - sx) / zoom, dy = (ev.clientY - sy) / zoom;
            obj.x = origins.get(id)!.x + dx;
            obj.y = origins.get(id)!.y + dy;
            const snapped = snapObject(obj);
            const sdx = snapped.x - origins.get(id)!.x;
            const sdy = snapped.y - origins.get(id)!.y;
            for (const [sid, orig] of origins) {
              const so = objects.find(o => o.id === sid);
              if (so) { so.x = orig.x + sdx; so.y = orig.y + sdy; }
            }
            for (const sid of selectedIds) {
              const so = objects.find(o => o.id === sid);
              const el = world.querySelector(`[data-id="${sid}"]`) as HTMLElement;
              if (so && el) { el.style.left = so.x + 'px'; el.style.top = so.y + 'px'; }
            }
            markDirty();
          }
          function onUp() { clearGuides(); document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
          return;
        }

        if (!e.shiftKey) selectObject(null);
        const sw = screenToWorld(e.clientX, e.clientY);
        let dragged = false;

        selectRect.style.display = 'none';

        function onMove(ev: MouseEvent) {
          dragged = true;
          const c = screenToWorld(ev.clientX, ev.clientY);
          const rx = Math.min(sw.x, c.x), ry = Math.min(sw.y, c.y);
          const rw = Math.abs(c.x - sw.x), rh = Math.abs(c.y - sw.y);
          selectRect.style.display = 'block';
          selectRect.style.left = rx + 'px'; selectRect.style.top = ry + 'px';
          selectRect.style.width = rw + 'px'; selectRect.style.height = rh + 'px';
        }
        function onUp(ev: MouseEvent) {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          selectRect.style.display = 'none';
          if (!dragged) return;
          const c = screenToWorld(ev.clientX, ev.clientY);
          const rx = Math.min(sw.x, c.x), ry = Math.min(sw.y, c.y);
          const rw = Math.abs(c.x - sw.x), rh = Math.abs(c.y - sw.y);
          if (rw < 5 && rh < 5) return;
          for (const obj of objects) {
            if (obj.x + obj.w > rx && obj.x < rx + rw && obj.y + obj.h > ry && obj.y < ry + rh) {
              selectedIds.add(obj.id);
            }
          }
          updateSelectionVisuals();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });

      viewport.addEventListener('dblclick', (e: MouseEvent) => {
        const objEl = (e.target as HTMLElement).closest('.canvas-obj') as HTMLDivElement | null;
        if (!objEl) return;
        const id = parseInt(objEl.dataset.id);
        const obj = objects.find(o => o.id === id);
        if (!obj) return;

        if (obj.type === 'image') {
          openInlineCrop(obj);
          return;
        }

        if (obj.type === 'markup') {
          const textEl = objEl.querySelector('.markup-text') as HTMLElement | null;
          if (!textEl) return;
          selectObject(id);
          textEl.contentEditable = 'true';
          textEl.focus();
          const range = document.createRange();
          range.selectNodeContents(textEl);
          range.collapse(false);
          const sel = window.getSelection()!;
          sel.removeAllRanges();
          sel.addRange(range);
          function onBlur() {
            textEl.contentEditable = 'false';
            const newT = textEl.textContent!.trim();
            if (newT !== obj.markupText) pushUndo();
            obj.markupText = newT || 'Note';
            textEl.removeEventListener('blur', onBlur);
            renderObjects(); markDirty();
          }
          textEl.addEventListener('blur', onBlur);
          textEl.addEventListener('keydown', (ev: KeyboardEvent) => { if (ev.key === 'Escape') textEl.blur(); });
          return;
        }

        if (obj.type !== 'text') return;

        selectObject(id);
        const ph = objEl.querySelector('.placeholder-text');
        if (ph) ph.remove();
        if (!obj.content) objEl.textContent = '';
        objEl.contentEditable = 'true';
        objEl.focus();
        const range = document.createRange();
        range.selectNodeContents(objEl);
        range.collapse(false);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);

        function onBlur() {
          objEl.contentEditable = 'false';
          objEl.querySelectorAll('.resize-handle').forEach(h => h.remove());
          const newText = objEl.textContent!.trim();
          if (newText !== obj.content) pushUndo();
          obj.content = newText;
          objEl.removeEventListener('blur', onBlur);
          renderObjects(); markDirty();
        }
        objEl.addEventListener('blur', onBlur);
        objEl.addEventListener('keydown', (ev: KeyboardEvent) => { if (ev.key === 'Escape') objEl.blur(); });
      });

      const cropBar = document.getElementById('cropBar')!;
      const cropApplyBtn = document.querySelector('.crop-apply') as HTMLButtonElement;
      const cropResetBtn = document.querySelector('.crop-reset') as HTMLButtonElement;
      const cropCancelBtn = document.querySelector('.crop-cancel') as HTMLButtonElement;
      let cropCx = 0, cropCy = 0, cropCw = 0, cropCh = 0, cropObjW = 0, cropObjH = 0;

      function openInlineCrop(obj: CanvasObject) {
        if (cropState) closeCrop();
        const el = world.querySelector(`[data-id="${obj.id}"]`) as HTMLElement;
        if (!el) return;

        selectedIds.clear();
        selectedIds.add(obj.id);
        el.classList.add('cropping');
        el.classList.remove('selected');

        const wrapper = el.querySelector('.img-wrapper') as HTMLElement;
        if (!wrapper) return;

        wrapper.innerHTML = '';

        const fullImg = document.createElement('img');
        fullImg.crossOrigin = 'anonymous';
        const { data } = supabase.storage.from('project-assets').getPublicUrl(obj.content);
        fullImg.src = data.publicUrl;
        fullImg.className = 'crop-full-img';
        fullImg.style.width = '100%';
        fullImg.style.height = '100%';
        fullImg.style.objectFit = 'fill';
        fullImg.draggable = false;
        wrapper.appendChild(fullImg);

        const cRect = document.createElement('div');
        cRect.className = 'crop-rect';
        wrapper.appendChild(cRect);

        const clipDiv = document.createElement('div');
        clipDiv.className = 'crop-img-clip';
        cRect.appendChild(clipDiv);

        const cImg = document.createElement('img');
        cImg.src = fullImg.src;
        cImg.draggable = false;
        clipDiv.appendChild(cImg);

        ['tl','tr','bl','br'].forEach(pos => {
          const h = document.createElement('div');
          h.className = `crop-handle ch-${pos}`;
          h.dataset.handle = pos;
          cRect.appendChild(h);
        });

        const W = obj.w, H = obj.h;
        cropObjW = W; cropObjH = H;

        if (obj.crop) {
          cropCx = obj.crop.x / 100 * W;
          cropCy = obj.crop.y / 100 * H;
          cropCw = obj.crop.w / 100 * W;
          cropCh = obj.crop.h / 100 * H;
        } else {
          cropCx = 0; cropCy = 0; cropCw = W; cropCh = H;
        }

        cropState = { objId: obj.id };
        cropBar.classList.add('visible');

        function updateCrop() {
          cRect.style.left = cropCx + 'px';
          cRect.style.top = cropCy + 'px';
          cRect.style.width = cropCw + 'px';
          cRect.style.height = cropCh + 'px';
          cImg.style.position = 'absolute';
          cImg.style.width = W + 'px';
          cImg.style.height = H + 'px';
          cImg.style.left = -cropCx + 'px';
          cImg.style.top = -cropCy + 'px';
        }
        updateCrop();

        cRect.addEventListener('mousedown', (ev: MouseEvent) => {
          if ((ev.target as HTMLElement).closest('.crop-handle')) return;
          ev.preventDefault(); ev.stopPropagation();
          const sx = ev.clientX, sy = ev.clientY;
          const ocx = cropCx, ocy = cropCy;
          function onMove(mv: MouseEvent) {
            cropCx = Math.max(0, Math.min(W - cropCw, ocx + (mv.clientX - sx) / zoom));
            cropCy = Math.max(0, Math.min(H - cropCh, ocy + (mv.clientY - sy) / zoom));
            updateCrop();
          }
          function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        });

        cRect.querySelectorAll('.crop-handle').forEach((h: Element) => {
          (h as HTMLElement).addEventListener('mousedown', (ev: MouseEvent) => {
            ev.preventDefault(); ev.stopPropagation();
            const sx = ev.clientX, sy = ev.clientY;
            const ocx = cropCx, ocy = cropCy, ocw = cropCw, och = cropCh;
            const pos = (h as HTMLElement).dataset.handle!;
            function onMove(mv: MouseEvent) {
              const dx = (mv.clientX - sx) / zoom, dy = (mv.clientY - sy) / zoom;
              if (pos.includes('r')) cropCw = Math.max(20, Math.min(W - cropCx, ocw + dx));
              if (pos.includes('b')) cropCh = Math.max(20, Math.min(H - cropCy, och + dy));
              if (pos.includes('l')) { const nc = Math.max(0, ocx + dx); cropCw = ocw + (ocx - nc); if (cropCw < 20) cropCw = 20; else cropCx = nc; }
              if (pos.includes('t')) { const nc = Math.max(0, ocy + dy); cropCh = och + (ocy - nc); if (cropCh < 20) cropCh = 20; else cropCy = nc; }
              updateCrop();
            }
            function onUp() { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
          });
        });
      }

      cropApplyBtn.addEventListener('click', () => {
        if (!cropState) return;
        const obj = objects.find(o => o.id === cropState!.objId);
        if (!obj) { closeCrop(); return; }
        pushUndo();
        obj.crop = {
          x: (cropCx / cropObjW) * 100,
          y: (cropCy / cropObjH) * 100,
          w: (cropCw / cropObjW) * 100,
          h: (cropCh / cropObjH) * 100,
        };
        obj.x += cropCx;
        obj.y += cropCy;
        obj.w = cropCw;
        obj.h = cropCh;
        closeCrop(); renderObjects(); markDirty();
      });

      cropResetBtn.addEventListener('click', () => {
        if (!cropState) return;
        pushUndo();
        const obj = objects.find(o => o.id === cropState!.objId);
        if (obj) obj.crop = null;
        closeCrop(); renderObjects(); markDirty();
      });

      cropCancelBtn.addEventListener('click', () => {
        closeCrop(); renderObjects();
      });

      function closeCrop() {
        if (!cropState) return;
        const el = world.querySelector(`[data-id="${cropState.objId}"]`) as HTMLElement;
        if (el) el.classList.remove('cropping');
        cropState = null;
        cropBar.classList.remove('visible');
        renderObjects();
      }

      function setTool(tool: 'pointer' | 'rect' | 'markup' | 'draw' | 'eyedropper') {
        activeTool = tool;
        document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
        markupBar.classList.remove('visible');
        drawBar.classList.remove('visible');
        eyedropperBar.classList.remove('visible');
        eyedropperLoupe.classList.remove('visible');
        viewport.classList.remove('drawing');
        markupBuild = null;
        eyedropperStep = 0;
        eyedropperColor = null;
        document.querySelector('.step-num')!.textContent = '1';
        document.querySelector('.step-num')!.nextElementSibling!.textContent = 'Draw rectangle around area';
        if (tool === 'rect') {
          document.querySelector('[data-tool="rect"]')?.classList.add('active');
          viewport.classList.add('drawing');
        } else if (tool === 'markup') {
          document.querySelector('[data-tool="markup"]')?.classList.add('active');
          viewport.classList.add('drawing');
          markupBar.classList.add('visible');
        } else if (tool === 'draw') {
          document.querySelector('[data-tool="draw"]')?.classList.add('active');
          viewport.classList.add('drawing');
          drawBar.classList.add('visible');
        } else if (tool === 'eyedropper') {
          document.querySelector('[data-tool="eyedropper"]')?.classList.add('active');
          viewport.classList.add('drawing');
          eyedropperBar.classList.add('visible');
          eyedropperStep = 1;
          eyedropperText.textContent = 'Hover over a color and click to pick';
          eyedropperSwatch.style.background = '#333';
        }
      }

      document.querySelector('[data-tool="rect"]')?.addEventListener('click', () => setTool(activeTool === 'rect' ? 'pointer' : 'rect'));
      document.querySelector('[data-tool="markup"]')?.addEventListener('click', () => setTool(activeTool === 'markup' ? 'pointer' : 'markup'));
      document.querySelector('[data-tool="draw"]')?.addEventListener('click', () => setTool(activeTool === 'draw' ? 'pointer' : 'draw'));
      document.querySelector('[data-tool="eyedropper"]')?.addEventListener('click', () => setTool(activeTool === 'eyedropper' ? 'pointer' : 'eyedropper'));

      function showContextMenu(e: MouseEvent) {
        const objEl = (e.target as HTMLElement).closest('.canvas-obj') as HTMLDivElement | null;
        const wp = screenToWorld(e.clientX, e.clientY);
        contextWorldX = wp.x; contextWorldY = wp.y;
        const onObj = !!objEl;
        if (onObj) { const id = parseInt(objEl!.dataset.id); if (!selectedIds.has(id)) selectObject(id); }

        const showCls = onObj ? '' : 'none';
        const hideCls = onObj ? 'none' : '';
        document.querySelectorAll('[data-ctx-obj]').forEach(el => el.setAttribute('style', `display: ${showCls}`));

        contextMenu.style.display = 'block';
        let x = e.clientX, y = e.clientY;
        if (x + 190 > window.innerWidth) x = window.innerWidth - 190;
        if (y + 250 > window.innerHeight) y = window.innerHeight - 250;
        contextMenu.style.left = x + 'px'; contextMenu.style.top = y + 'px';
      }

      function hideContextMenu() { contextMenu.style.display = 'none'; }

      document.addEventListener('mousedown', (e: MouseEvent) => { if (!contextMenu.contains(e.target as Node)) hideContextMenu(); });

      function addImages(wx?: number, wy?: number) {
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.accept = 'image/*';
        input.onchange = async (e: Event) => {
          const files = (e.target as HTMLInputElement).files;
          if (!files) return;
          pushUndo();
          const center = (wx !== undefined) ? { x: wx, y: wy } : viewportCenter();
          let count = 0;
          for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const result = await uploadImage(file, projectId!, supabase);
            if (!result) continue;
            let w = result.width, h = result.height;
            if (w > 600) { const s = 600 / w; w = 600; h = Math.round(h * s); }
            if (h > 500) { const s = 500 / h; h = Math.round(h * s); w = Math.round(w * s); }
            const id = nextId++;
            const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
            objects.push(normalizeObject({
              id, type: 'image',
              x: center!.x - w / 2 + count * 30, y: center!.y - h / 2 + count * 30,
              w, h, content: result.path, zIndex: mz + count,
            }));
            count++;
          }
          if (count > 0) {
            selectObject(objects[objects.length - 1].id);
            renderObjects(); markDirty();
          }
        };
        input.click();
      }

      function addText(style: 'title' | 'subtitle' | 'description', wx?: number, wy?: number) {
        pushUndo();
        const center = (wx !== undefined) ? { x: wx, y: wy } : viewportCenter();
        const sizes = { title: { w: 400, h: 56 }, subtitle: { w: 350, h: 40 }, description: { w: 300, h: 28 } };
        const s = sizes[style] || sizes.title;
        const id = nextId++;
        const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
        objects.push(normalizeObject({
          id, type: 'text', x: center!.x - s.w / 2, y: center!.y - s.h / 2,
          w: s.w, h: s.h, content: '', textStyle: style, zIndex: mz,
        }));
        selectObject(id); renderObjects(); markDirty();
        setTimeout(() => {
          const el = world.querySelector(`[data-id="${id}"]`) as HTMLElement;
          if (el) el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        }, 50);
      }

      function deleteSelected() {
        if (selectedIds.size === 0) return;
        pushUndo();
        objects = objects.filter(o => !selectedIds.has(o.id));
        selectedIds.clear();
        renderObjects(); markDirty();
      }

      document.querySelector('[data-toolbar="home"]')?.addEventListener('click', async () => { if (objects.length > 0) await saveProject(); router.push('/'); });
      document.querySelector('[data-toolbar="addImage"]')?.addEventListener('click', () => addImages());
      document.querySelector('[data-toolbar="addTitle"]')?.addEventListener('click', () => addText('title'));
      document.querySelector('[data-toolbar="addSubtitle"]')?.addEventListener('click', () => addText('subtitle'));
      document.querySelector('[data-toolbar="addDesc"]')?.addEventListener('click', () => addText('description'));
      document.querySelector('[data-toolbar="save"]')?.addEventListener('click', () => saveProject());

      function zoomAt(f: number) {
        const vw = (window.innerWidth - 52) / 2, vh = window.innerHeight / 2;
        const wx = (vw - panX) / zoom, wy = (vh - panY) / zoom;
        zoom = Math.min(5, Math.max(0.1, zoom * f));
        panX = vw - wx * zoom; panY = vh - wy * zoom;
        applyTransform();
      }

      document.querySelector('[data-toolbar="zoomIn"]')?.addEventListener('click', () => zoomAt(1.2));
      document.querySelector('[data-toolbar="zoomOut"]')?.addEventListener('click', () => zoomAt(1 / 1.2));
      document.querySelector('[data-toolbar="zoomReset"]')?.addEventListener('click', () => { zoom = 1; panX = 0; panY = 0; applyTransform(); });

      document.addEventListener('keydown', (e: KeyboardEvent) => {
        const inEdit = (e.target as HTMLElement).closest('[contenteditable]');
        if (e.code === 'Space' && !inEdit) { e.preventDefault(); spaceDown = true; viewport.classList.add('panning'); }
        if ((e.key === 'Delete' || e.key === 'Backspace') && !inEdit) deleteSelected();
        if (e.key === 'Escape') { selectObject(null); hideContextMenu(); setTool('pointer'); if (cropState) { closeCrop(); renderObjects(); } }
        if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !inEdit) setTool(activeTool === 'rect' ? 'pointer' : 'rect');
        if (e.key === 'm' && !e.ctrlKey && !e.metaKey && !inEdit) setTool(activeTool === 'markup' ? 'pointer' : 'markup');
        if (e.key === 'd' && !e.ctrlKey && !e.metaKey && !inEdit) setTool(activeTool === 'draw' ? 'pointer' : 'draw');
        if (e.key === 'i' && !e.ctrlKey && !e.metaKey && !inEdit) setTool(activeTool === 'eyedropper' ? 'pointer' : 'eyedropper');
        if (e.key === 'v' && !e.ctrlKey && !e.metaKey && !inEdit) setTool('pointer');
        if (e.key === 'a' && (e.ctrlKey || e.metaKey) && !inEdit) {
          e.preventDefault();
          objects.forEach(o => selectedIds.add(o.id));
          updateSelectionVisuals();
        }
        if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !inEdit) { e.preventDefault(); undo(); }
        if ((e.key === 'y' && (e.ctrlKey || e.metaKey) && !inEdit) || (e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey && !inEdit)) { e.preventDefault(); redo(); }
        if (e.key === 's' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveProject(); }
      });

      document.addEventListener('keyup', (e: KeyboardEvent) => {
        if (e.code === 'Space') { spaceDown = false; viewport.classList.remove('panning'); }
      });

      document.addEventListener('keydown', async (e2: KeyboardEvent) => {
        if (e2.key === 'v' && (e2.ctrlKey || e2.metaKey) && !(e2.target as HTMLElement).closest('[contenteditable]')) {
          const clipboardItems = await navigator.clipboard.read();
          for (const item of clipboardItems) {
            const imageTypes = item.types.filter(t => t.startsWith('image/'));
            if (imageTypes.length === 0) continue;
            e2.preventDefault();
            const blob = await item.getType(imageTypes[0]);
            const file = new File([blob], 'clipboard.png', { type: blob.type });
            const result = await uploadImage(file, projectId!, supabase);
            if (!result) return;
            pushUndo();
            let w = result.width, h = result.height;
            if (w > 600) { const s = 600 / w; w = 600; h = Math.round(h * s); }
            if (h > 500) { const s = 500 / h; h = Math.round(h * s); w = Math.round(w * s); }
            const center = viewportCenter();
            const id = nextId++;
            const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
            objects.push(normalizeObject({
              id, type: 'image',
              x: center.x - w / 2, y: center.y - h / 2,
              w, h, content: result.path, zIndex: mz,
            }));
            selectObject(id);
            renderObjects();
            markDirty();
            break;
          }
        }
      });

      async function saveProject() {
        console.log('[canvas] saving, objects:', objects.length, objects.map(o => ({type: o.type, content: o.content?.substring?.(0, 40)})));
        const { error } = await supabase
          .from('projects')
          .update({
            objects: JSON.parse(JSON.stringify(objects)),
            canvas_state: { panX, panY, zoom },
          })
          .eq('id', projectId);

        if (error) {
          console.error('[canvas] save error:', error.message);
        } else {
          saveIndicator.classList.add('show');
          setTimeout(() => saveIndicator.classList.remove('show'), 1500);
        }
      }

      async function loadProject() {
        console.log('[canvas] loading project:', projectId);
        const { data, error } = await supabase
          .from('projects')
          .select('*')
          .eq('id', projectId)
          .single();

        console.log('[canvas] load result:', { data: data ? 'ok' : null, error: error?.message });

        if (error || !data) {
          console.error('[canvas] failed to load, redirecting home');
          router.push('/');
          return;
        }

        const cs = (data as any).canvas_state || {};
        panX = Number(cs.panX) || 0;
        panY = Number(cs.panY) || 0;
        zoom = Number(cs.zoom) || 1;
        objects = ((data as any).objects || []).map(normalizeObject);
        nextId = objects.length ? Math.max(...objects.map(o => o.id)) + 1 : 1;
        applyTransform();
        renderObjects();
        setIsLoaded(true);
        console.log('[canvas] loaded successfully, objects:', objects.length);
      }

      viewport.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.dataTransfer!.dropEffect = 'copy';
      });

      viewport.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        const files = e.dataTransfer!.files;
        if (!files || files.length === 0) return;

        const center = viewportCenter();
        const STAGGER = 30;
        let count = 0;
        pushUndo();

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file.type.startsWith('image/')) continue;
          const result = await uploadImage(file, projectId!, supabase);
          if (!result) continue;

          let w = result.width, h = result.height;
          if (w > 600) { const s = 600 / w; w = 600; h = Math.round(h * s); }
          if (h > 500) { const s = 500 / h; h = Math.round(h * s); w = Math.round(w * s); }

          const id = nextId++;
          const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
          objects.push(normalizeObject({
            id, type: 'image',
            x: center.x - w / 2 + count * STAGGER,
            y: center.y - h / 2 + count * STAGGER,
            w, h, content: result.path, zIndex: mz + count,
          }));
          count++;
        }

        if (count > 0) {
          selectObject(objects[objects.length - 1].id);
          renderObjects();
          markDirty();
        }
      });

      window.addEventListener('beforeunload', () => { if (objects.length > 0) saveProject(); });

      // Context menu handlers
      const ctxAddImages = document.querySelector('[data-ctx-action="addImages"]');
      const ctxAddText = document.querySelector('[data-ctx-action="addText"]');
      const ctxAddRect = document.querySelector('[data-ctx-action="addRect"]');
      const ctxDelete = document.querySelector('[data-ctx-action="delete"]');
      const ctxBringFront = document.querySelector('[data-ctx-action="bringFront"]');
      const ctxSendBack = document.querySelector('[data-ctx-action="sendBack"]');
      const ctxTextItems = document.querySelectorAll('[data-ctx-text]');

      ctxAddImages?.addEventListener('click', () => { hideContextMenu(); addImages(contextWorldX, contextWorldY); });
      ctxAddRect?.addEventListener('click', () => {
        hideContextMenu();
        pushUndo();
        const id = nextId++;
        const mz = objects.length ? Math.max(...objects.map(o => o.zIndex)) + 1 : 1;
        objects.push(normalizeObject({ id, type: 'shape', x: contextWorldX - 100, y: contextWorldY - 75, w: 200, h: 150, content: '', zIndex: mz }));
        selectObject(id); renderObjects(); markDirty();
      });
      ctxDelete?.addEventListener('click', () => { hideContextMenu(); deleteSelected(); });
      ctxBringFront?.addEventListener('click', () => {
        hideContextMenu();
        pushUndo();
        const mz = Math.max(...objects.map(o => o.zIndex), 0);
        let i = 1;
        for (const sid of selectedIds) {
          const o = objects.find(x => x.id === sid);
          if (o) o.zIndex = mz + i++;
        }
        renderObjects(); markDirty();
      });
      ctxSendBack?.addEventListener('click', () => {
        hideContextMenu();
        pushUndo();
        const mz = Math.min(...objects.map(o => o.zIndex), 0);
        let i = 1;
        for (const sid of selectedIds) {
          const o = objects.find(x => x.id === sid);
          if (o) o.zIndex = mz - i++;
        }
        renderObjects(); markDirty();
      });

      ctxTextItems.forEach((item: Element) => {
        (item as HTMLElement).addEventListener('click', (e: Event) => {
          const style = (item as HTMLElement).dataset.ctxText as 'title' | 'subtitle' | 'description';
          hideContextMenu();
          addText(style, contextWorldX, contextWorldY);
        });
      });

      // Suppress default right-click menu (our custom one is shown from startPan on mouseup)
      viewport.addEventListener('contextmenu', (e: MouseEvent) => {
        e.preventDefault();
      });

      applyTransform();
      loadProject();
    })();
  }, [projectId]);

  return (
    <div id="canvas-root">
      <div className="grid-layer" ref={gridLayerRef}></div>

      <div
        id="viewport"
        ref={viewportRef}
        onDragOver={(e) => e.preventDefault()}
      >
        <div id="world" ref={worldRef}>
          <div id="drawPreview"></div>
          <div id="selectRect"></div>
        </div>
      </div>

      <div id="toolbar">
        <button className="tool-btn" data-toolbar="home" title="Home">
          <svg viewBox="0 0 24 24">
            <path d="M3 12l9-9 9 9" />
            <path d="M9 21V12h6v9" />
          </svg>
        </button>
        <div className="toolbar-divider"></div>

        <button className="tool-btn" data-toolbar="addImage" title="Add Images">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        </button>
        <button className="tool-btn" data-toolbar="addTitle" title="Add Title">
          <svg viewBox="0 0 24 24">
            <path d="M4 7V4h16v3" />
            <line x1="12" y1="4" x2="12" y2="20" />
            <line x1="8" y1="20" x2="16" y2="20" />
          </svg>
        </button>
        <button className="tool-btn" data-toolbar="addSubtitle" title="Add Subtitle">
          <svg viewBox="0 0 24 24">
            <path d="M7 7V4h10v3" opacity="0.7" />
            <line x1="12" y1="4" x2="12" y2="18" />
            <line x1="9" y1="18" x2="15" y2="18" />
          </svg>
        </button>
        <button className="tool-btn" data-toolbar="addDesc" title="Add Description">
          <svg viewBox="0 0 24 24">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="10" x2="20" y2="10" />
            <line x1="4" y1="14" x2="16" y2="14" />
            <line x1="4" y1="18" x2="12" y2="18" />
          </svg>
        </button>

        <div className="toolbar-divider"></div>

        <button className="tool-btn" data-tool="rect" title="Rectangle (R)">
          <svg viewBox="0 0 24 24">
            <rect x="3" y="3" width="18" height="18" rx="1" fill="none" />
          </svg>
        </button>
        <button className="tool-btn" data-tool="markup" title="Markup (M)">
          <svg viewBox="0 0 24 24">
            <path d="M12 19l7-7 3 3-7 7-3-3z" />
            <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z" />
            <path d="M2 2l7.586 7.586" />
            <circle cx="11" cy="11" r="2" />
          </svg>
        </button>
        <button className="tool-btn" data-tool="draw" title="Draw (D)">
          <svg viewBox="0 0 24 24">
            <path d="M17 3a2.83 2.83 0 114 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button className="tool-btn" data-tool="eyedropper" title="Eyedropper (I)">
          <svg viewBox="0 0 24 24">
            <path d="M20.71 5.63l-2.34-2.34a1 1 0 00-1.41 0l-3.54 3.54-1.41-1.41a1 1 0 00-1.42 0L9.17 6.83a1 1 0 000 1.42l1.41 1.41L3 17.25V21h3.75l7.59-7.58 1.41 1.41a1 1 0 001.42 0l1.41-1.41a1 1 0 000-1.42l-1.41-1.41 3.54-3.54a1 1 0 000-1.42z" />
          </svg>
        </button>

        <div className="toolbar-divider"></div>

        <button className="tool-btn" data-toolbar="save" title="Save (Ctrl+S)">
          <svg viewBox="0 0 24 24">
            <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v11a2 2 0 01-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" />
            <polyline points="7 3 7 8 15 8" />
          </svg>
        </button>

        <div className="toolbar-spacer"></div>

        <button className="tool-btn" data-toolbar="zoomIn" title="Zoom In">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="11" y1="8" x2="11" y2="14" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        <button className="tool-btn" data-toolbar="zoomOut" title="Zoom Out">
          <svg viewBox="0 0 24 24">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
            <line x1="8" y1="11" x2="14" y2="11" />
          </svg>
        </button>
        <button className="tool-btn" data-toolbar="zoomReset" title="Reset View">
          <svg viewBox="0 0 24 24">
            <path d="M3 12a9 9 0 109-9" />
            <polyline points="3 3 3 8 8 8" />
          </svg>
        </button>
      </div>

      <div id="cropBar">
        <span>Crop</span>
        <button className="crop-apply">Apply</button>
        <button className="crop-reset">Reset</button>
        <button className="crop-cancel">Cancel</button>
      </div>

      <div id="markupBar">
        <div className="step-num">1</div>
        <span>Draw rectangle around area</span>
      </div>

      <div id="eyedropperLoupe">
        <div className="loupe-hex">#000000</div>
      </div>

      <div id="eyedropperBar">
        <div className="swatch-preview"></div>
        <span>Hover over a color and click to pick</span>
      </div>

      <div id="drawBar">
        <label>
          <input type="color" id="drawColor" defaultValue="#F0C4A0" />
        </label>
        <label>
          <div className="size-preview">
            <div className="size-dot" style={{ width: '4px', height: '4px' }}></div>
          </div>
          <input
            type="range"
            id="drawSize"
            min="2"
            max="20"
            defaultValue="4"
          />
        </label>
      </div>

      <div id="contextMenu">
        <div className="ctx-item" data-ctx-action="addImages">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
          Add Images
        </div>
        <div className="ctx-sub">
          <div className="ctx-item" data-ctx-action="addText">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M4 7V4h16v3" />
              <line x1="12" y1="4" x2="12" y2="20" />
            </svg>
            Add Text <span className="arrow">&#9654;</span>
          </div>
          <div className="ctx-sub-menu">
            <div className="ctx-item" data-ctx-text="title">Title</div>
            <div className="ctx-item" data-ctx-text="subtitle">Subtitle</div>
            <div className="ctx-item" data-ctx-text="description">Description</div>
          </div>
        </div>
        <div className="ctx-item" data-ctx-action="addRect">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="1" />
          </svg>
          Add Rectangle
        </div>
        <div className="ctx-divider" data-ctx-obj="true"></div>
        <div className="ctx-item" data-ctx-obj="true" data-ctx-action="bringFront">Bring to Front</div>
        <div className="ctx-item" data-ctx-obj="true" data-ctx-action="sendBack">Send to Back</div>
        <div className="ctx-divider" data-ctx-obj="true"></div>
        <div className="ctx-item danger" data-ctx-obj="true" data-ctx-action="delete">Delete</div>
      </div>

      <div id="zoomIndicator">100%</div>
      <div id="saveIndicator">Saved</div>

      <canvas ref={samplerCanvasRef} style={{ display: 'none' }}></canvas>
    </div>
  );
}

export default function CanvasPage() {
  return (
    <Suspense fallback={<div style={{ background: '#1a1a1a', width: '100vw', height: '100vh' }} />}>
      <CanvasInner />
    </Suspense>
  );
}
