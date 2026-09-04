import './style.css';
import polygonClipping from 'polygon-clipping';

type BarKind = 'c' | 'm' | 'l';
type Bar = { kind: BarKind; level: number; diagonal: boolean; extraGapBefore: number };
type Shape = { bars: Bar[]; links: number[][] };
type Settings = {
  levelGaps: [number, number, number];
  barGap: number;
  angle: number;
  barWidth: number;
  linkWidth: number;
  horizontalTops: boolean;
  horizontalBottoms: boolean;
  roundedCorners: number;
  scale: number;
};
type Point = [number, number];
type Polygon = Point[][];

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const form = $('#controls');
const preview = $('#preview');
const error = $('#error');
const scaleOutput = $('#scale-output');
let currentSvg = '';

function parseNotation(source: string): Shape {
  const tokens = source.trim().toLowerCase().split(',').map((part) => part.trim()).filter(Boolean);
  if (!tokens.length) throw new Error('La notation est vide.');

  const bars: Bar[] = [];
  const links: number[][] = [];
  let pendingLinks: number[] = [];
  let pendingExtraGap = 0;
  let hasPendingGap = false;

  for (const token of tokens) {
    const barMatch = token.match(/^([cml])([0-3])(\/)?$/);
    if (barMatch) {
      if (bars.length) links.push(pendingLinks);
      bars.push({
        kind: barMatch[1] as BarKind,
        level: Number(barMatch[2]),
        diagonal: Boolean(barMatch[3]),
        extraGapBefore: pendingExtraGap,
      });
      pendingLinks = [];
      pendingExtraGap = 0;
      hasPendingGap = false;
      continue;
    }
    const gapMatch = token.match(/^e(-?\d+(?:\.\d+)?)$/);
    if (gapMatch) {
      if (!bars.length) throw new Error(`Espacement « ${token} » mal placé.`);
      pendingExtraGap += Number(gapMatch[1]);
      hasPendingGap = true;
      continue;
    }
    if (/^[0-3]+$/.test(token)) {
      if (!bars.length || pendingLinks.length) throw new Error(`Lien « ${token} » mal placé.`);
      pendingLinks = [...new Set(token.split('').map(Number))];
      continue;
    }
    throw new Error(`Élément inconnu : « ${token} »`);
  }

  if (pendingLinks.length) throw new Error('La notation se termine par un lien sans barre.');
  if (hasPendingGap) throw new Error('La notation se termine par un espacement sans barre.');
  if (bars.length < 2) throw new Error('Il faut au moins deux barres.');
  return { bars, links };
}

function numberValue(id: string): number {
  const input = $<HTMLInputElement>(`#${id}`);
  const value = Number(input.value);
  if (!Number.isFinite(value)) throw new Error(`Valeur incorrecte pour « ${id} ».`);
  return value;
}

function getSettings(): Settings {
  return {
    levelGaps: [numberValue('gap01'), numberValue('gap12'), numberValue('gap23')],
    barGap: numberValue('barGap'),
    angle: numberValue('angle'),
    barWidth: numberValue('barWidth'),
    linkWidth: numberValue('linkWidth'),
    horizontalTops: $<HTMLInputElement>('#horizontalTops').checked,
    horizontalBottoms: $<HTMLInputElement>('#horizontalBottoms').checked,
    roundedCorners: numberValue('roundedCorners'),
    scale: numberValue('scale'),
  };
}

function renderSvg(shape: Shape, settings: Settings): string {
  const unit = 48;
  const levelHeight = [0];
  settings.levelGaps.forEach((gap, index) => levelHeight.push(levelHeight[index] + gap * unit));
  const totalHeight = levelHeight[3];
  const levelY = levelHeight.map((height) => totalHeight - height);
  const spans: Record<BarKind, number> = { c: 1, m: 2, l: 3 };
  const stroke = settings.barWidth * unit;
  const linkStroke = settings.linkWidth * unit;
  const angle = settings.angle * Math.PI / 180;
  const bars: Array<{ xBottom: number; xTop: number; yBottom: number; yTop: number }> = [];
  let previousRightEdge: number | null = null;

  for (const bar of shape.bars) {
    const bottomLevel = bar.level;
    const topLevel = bar.level + spans[bar.kind];
    if (bottomLevel < 0 || topLevel > 3) {
      throw new Error(`La barre ${bar.kind}${bar.level}${bar.diagonal ? '/' : ''} dépasse le niveau 3.`);
    }
    const yBottom = levelY[bottomLevel];
    const yTop = levelY[topLevel];
    const height = yBottom - yTop;
    const dx = bar.diagonal ? -Math.tan(angle) * height : 0;
    // On compense le dépassement vertical des coins, puis on prolonge
    // l'enveloppe d'une demi-épaisseur de lien au-delà de chaque niveau.
    const cornerOffsetY = bar.diagonal ? Math.abs(Math.sin(angle)) * stroke / 2 : 0;
    const verticalExtension = linkStroke / 2 - cornerOffsetY;
    const xExtension = height === 0 ? 0 : (dx / height) * verticalExtension;
    const rawBar = {
      xBottom: -xExtension,
      xTop: dx + xExtension,
      yBottom: yBottom + verticalExtension,
      yTop: yTop - verticalExtension,
    };
    const axisLength = Math.hypot(
      rawBar.xTop - rawBar.xBottom,
      rawBar.yTop - rawBar.yBottom,
    );
    const horizontalHalfStroke = Math.abs(rawBar.yTop - rawBar.yBottom) / axisLength * stroke / 2;
    const rawLeftEdge = Math.min(rawBar.xBottom, rawBar.xTop) - horizontalHalfStroke;
    const rawRightEdge = Math.max(rawBar.xBottom, rawBar.xTop) + horizontalHalfStroke;
    const gap = settings.barGap * unit * (1 + bar.extraGapBefore);
    const offsetX: number = previousRightEdge === null
      ? -rawLeftEdge
      : previousRightEdge + gap - rawLeftEdge;
    bars.push({
      xBottom: rawBar.xBottom + offsetX,
      xTop: rawBar.xTop + offsetX,
      yBottom: rawBar.yBottom,
      yTop: rawBar.yTop,
    });
    previousRightEdge = rawRightEdge + offsetX;
  }

  const polygons: Polygon[] = [];
  const linePolygon = (x1: number, y1: number, x2: number, y2: number, width: number): Polygon => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length === 0) throw new Error('Une forme a une longueur nulle.');
    const nx = (-dy / length) * width / 2;
    const ny = (dx / length) * width / 2;
    const ring: Point[] = [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
      [x1 + nx, y1 + ny],
    ];
    return [ring];
  };

  const barPolygons = bars.map((bar) => {
    const polygon = linePolygon(bar.xBottom, bar.yBottom, bar.xTop, bar.yTop, stroke);
    const ring = polygon[0];
    const sideSlope = (bar.xTop - bar.xBottom) / (bar.yTop - bar.yBottom);
    const moveAlongSideToY = (point: Point, targetY: number): void => {
      point[0] += (targetY - point[1]) * sideSlope;
      point[1] = targetY;
    };
    if (settings.horizontalTops) {
      const horizontalTop = Math.min(...ring.slice(0, -1).map((point) => point[1]));
      moveAlongSideToY(ring[1], horizontalTop);
      moveAlongSideToY(ring[2], horizontalTop);
    }
    if (settings.horizontalBottoms) {
      const horizontalBottom = Math.max(...ring.slice(0, -1).map((point) => point[1]));
      moveAlongSideToY(ring[0], horizontalBottom);
      moveAlongSideToY(ring[3], horizontalBottom);
      ring[4] = [...ring[0]];
    }
    return polygon;
  });
  const horizontalRange = (polygon: Polygon, y: number): [number, number] => {
    const intersections: number[] = [];
    const ring = polygon[0];
    const epsilon = 1e-7;
    for (let index = 0; index < ring.length - 1; index += 1) {
      const first = ring[index];
      const second = ring[index + 1];
      if (Math.abs(first[1] - y) < epsilon) intersections.push(first[0]);
      if ((first[1] < y && second[1] > y) || (first[1] > y && second[1] < y)) {
        const ratio = (y - first[1]) / (second[1] - first[1]);
        intersections.push(first[0] + (second[0] - first[0]) * ratio);
      }
    }
    if (!intersections.length) throw new Error('Un lien ne rencontre pas la barre au niveau demandé.');
    return [Math.min(...intersections), Math.max(...intersections)];
  };

  shape.links.forEach((levels, index) => {
    levels.forEach((level) => {
      const y = levelY[level];
      const linkEdgesY = [y - linkStroke / 2, y, y + linkStroke / 2];
      const leftEdge = Math.min(
        ...linkEdgesY.map((edgeY) => horizontalRange(barPolygons[index], edgeY)[1]),
      );
      const rightEdge = Math.max(
        ...linkEdgesY.map((edgeY) => horizontalRange(barPolygons[index + 1], edgeY)[0]),
      );
      polygons.push(linePolygon(leftEdge, y, rightEdge, y, linkStroke));
    });
  });
  polygons.push(...barPolygons);

  const merged = polygonClipping.union(polygons[0], ...polygons.slice(1));
  const format = (value: number): string => Number(value.toFixed(4)).toString();
  const cornerRadius = settings.roundedCorners * unit;
  const pathData = merged.flatMap((polygon) => polygon.map((closedRing) => {
    const ring = closedRing.slice(0, -1) as Point[];
    const corners = ring.map((point, index) => {
      if (cornerRadius === 0) return { entry: point, exit: point, rounded: false };
      const previous = ring[(index - 1 + ring.length) % ring.length];
      const next = ring[(index + 1) % ring.length];
      const incomingLength = Math.hypot(previous[0] - point[0], previous[1] - point[1]);
      const outgoingLength = Math.hypot(next[0] - point[0], next[1] - point[1]);
      const distance = Math.min(cornerRadius, incomingLength / 2, outgoingLength / 2);
      const toward = (other: Point, length: number): Point => [
        point[0] + (other[0] - point[0]) / length * distance,
        point[1] + (other[1] - point[1]) / length * distance,
      ];
      return {
        entry: toward(previous, incomingLength),
        exit: toward(next, outgoingLength),
        rounded: true,
      };
    });
    let data = `M${format(corners[corners.length - 1].exit[0])} ${format(corners[corners.length - 1].exit[1])}`;
    corners.forEach((corner, index) => {
      const point = ring[index];
      data += `L${format(corner.entry[0])} ${format(corner.entry[1])}`;
      data += corner.rounded
        ? `Q${format(point[0])} ${format(point[1])} ${format(corner.exit[0])} ${format(corner.exit[1])}`
        : '';
    });
    return `${data}Z`;
  })).join('');

  const allX = bars.flatMap((bar) => [bar.xBottom, bar.xTop]);
  const allY = bars.flatMap((bar) => [bar.yBottom, bar.yTop]);
  const pad = Math.max(stroke, 10);
  const minX = Math.min(...allX) - pad;
  const maxX = Math.max(...allX) + pad;
  const minY = Math.min(...allY) - pad;
  const maxY = Math.max(...allY) + pad;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="200" height="200" role="img" aria-label="Logo généré">
  <rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="#6b1426" />
  <path d="${pathData}" fill="#e9e8e3" fill-rule="evenodd" />
</svg>`;
}

function update(): void {
  try {
    const notation = $<HTMLInputElement>('#notation').value;
    const settings = getSettings();
    currentSvg = renderSvg(parseNotation(notation), settings);
    preview.innerHTML = currentSvg;
    const svg = preview.querySelector('svg');
    if (svg) svg.style.transform = `scale(${settings.scale})`;
    scaleOutput.textContent = `${settings.scale.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}×`;
    document.querySelectorAll<HTMLOutputElement>('output[data-value-for]').forEach((output) => {
      const input = $<HTMLInputElement>(`#${output.dataset.valueFor}`);
      const value = Number(input.value).toString().replace('-', '−');
      output.textContent = input.id === 'angle' ? `${value}°` : value;
    });
    error.textContent = '';
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : 'Notation invalide.';
  }
}

form.addEventListener('input', update);
$('#download').addEventListener('click', () => {
  if (!currentSvg) return;
  const blob = new Blob([currentSvg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'ut7.svg';
  anchor.click();
  URL.revokeObjectURL(url);
});

update();
