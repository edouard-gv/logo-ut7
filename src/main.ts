import './style.css';
import polygonClipping from 'polygon-clipping';

type BarKind = 'c' | 'm' | 'l';
type Bar = {
  kind: BarKind;
  level: number;
  diagonal: boolean;
  extraGapBefore: number;
  empty: boolean;
  widthMultiplier: number;
};
type Shape = { bars: Bar[]; links: number[][] };
type Settings = {
  levelGaps: [number, number, number];
  barGap: number;
  angle: number;
  barWidth: number;
  linkWidth: number;
  horizontalTops: boolean;
  horizontalBottoms: boolean;
  inscribedTrapezoid: boolean;
  transparentBackground: boolean;
  transparentShapes: boolean;
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
        empty: false,
        widthMultiplier: 1,
      });
      pendingLinks = [];
      pendingExtraGap = 0;
      hasPendingGap = false;
      continue;
    }
    const emptyBarMatch = token.match(/^b(\+?\d+(?:\.\d+)?)?$/);
    if (emptyBarMatch) {
      if (bars.length) links.push(pendingLinks);
      const widthMultiplier = emptyBarMatch[1] === undefined ? 1 : Number(emptyBarMatch[1]);
      if (widthMultiplier < 0) throw new Error(`La largeur de « ${token} » ne peut pas être négative.`);
      bars.push({
        kind: 'l',
        level: 0,
        diagonal: false,
        extraGapBefore: pendingExtraGap,
        empty: true,
        widthMultiplier,
      });
      pendingLinks = [];
      pendingExtraGap = 0;
      hasPendingGap = false;
      continue;
    }
    const gapMatch = token.match(/^e([+-]?\d+(?:\.\d+)?)$/);
    if (gapMatch) {
      if (!bars.length) throw new Error(`Espacement « ${token} » mal placé.`);
      pendingExtraGap += Number(gapMatch[1]);
      hasPendingGap = true;
      continue;
    }
    const isLinkToken = /^[0-3]+$/.test(token);
    if (isLinkToken) {
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
    inscribedTrapezoid: $<HTMLInputElement>('#inscribedTrapezoid').checked,
    transparentBackground: $<HTMLInputElement>('#transparentBackground').checked,
    transparentShapes: $<HTMLInputElement>('#transparentShapes').checked,
    roundedCorners: numberValue('roundedCorners'),
    scale: numberValue('scale'),
  };
}

type SavedConfiguration = [
  version: 1,
  notation: string,
  values: [
    gap01: number,
    gap12: number,
    gap23: number,
    barGap: number,
    angle: number,
    barWidth: number,
    linkWidth: number,
    roundedCorners: number,
    scale: number,
  ],
  options: number,
];

function createSavedConfiguration(): SavedConfiguration {
  const settings = getSettings();
  const options = Number(settings.horizontalTops)
    | (Number(settings.horizontalBottoms) << 1)
    | (Number(settings.inscribedTrapezoid) << 2)
    | (Number(settings.transparentBackground) << 3)
    | (Number(settings.transparentShapes) << 4);
  return [
    1,
    $<HTMLInputElement>('#notation').value,
    [
      ...settings.levelGaps,
      settings.barGap,
      settings.angle,
      settings.barWidth,
      settings.linkWidth,
      settings.roundedCorners,
      settings.scale,
    ],
    options,
  ];
}

function encodeConfiguration(configuration: SavedConfiguration): string {
  const bytes = new TextEncoder().encode(JSON.stringify(configuration));
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeConfiguration(encoded: string): SavedConfiguration {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as SavedConfiguration;
}

function restoreConfigurationFromUrl(): string | null {
  const encoded = new URL(window.location.href).searchParams.get('config');
  if (!encoded) return null;
  try {
    const configuration = decodeConfiguration(encoded);
    const [version, notation, savedValues, options] = configuration;
    if (version !== 1 || typeof notation !== 'string' || !Array.isArray(savedValues) || savedValues.length < 9 || typeof options !== 'number') {
      throw new Error('version inconnue');
    }
    $<HTMLInputElement>('#notation').value = notation;
    const values: Record<string, number> = {
      gap01: savedValues[0],
      gap12: savedValues[1],
      gap23: savedValues[2],
      barGap: savedValues[3],
      angle: savedValues[4],
      barWidth: savedValues[5],
      linkWidth: savedValues[6],
      roundedCorners: savedValues[7],
      scale: savedValues[8],
    };
    Object.entries(values).forEach(([id, value]) => {
      if (!Number.isFinite(value)) return;
      const input = $<HTMLInputElement>(`#${id}`);
      const min = input.min === '' ? value : Number(input.min);
      const max = input.max === '' ? value : Number(input.max);
      input.value = Math.min(max, Math.max(min, value)).toString();
    });
    const checks: Record<string, boolean> = {
      horizontalTops: Boolean(options & 1),
      horizontalBottoms: Boolean(options & 2),
      inscribedTrapezoid: Boolean(options & 4),
      transparentBackground: Boolean(options & 8),
      transparentShapes: Boolean(options & 16),
    };
    Object.entries(checks).forEach(([id, checked]) => {
      $<HTMLInputElement>(`#${id}`).checked = checked === true;
    });
    return null;
  } catch {
    return 'La configuration présente dans l’URL est invalide.';
  }
}

function renderSvg(shape: Shape, settings: Settings): string {
  // Trois niveaux de 48 unités occupent 144 unités et laissent une marge naturelle dans un aperçu de 200 px.
  const svgUnitsPerLevel = 48;
  // Les quatre niveaux sont numérotés de 0 en bas à 3 en haut.
  const levelHeight = [0];
  settings.levelGaps.forEach((gap, index) => levelHeight.push(levelHeight[index] + gap * svgUnitsPerLevel));
  const totalHeight = levelHeight[3];
  const levelY = levelHeight.map((height) => totalHeight - height);
  const spans: Record<BarKind, number> = { c: 1, m: 2, l: 3 };
  const stroke = settings.barWidth * svgUnitsPerLevel;
  const linkStroke = settings.linkWidth * svgUnitsPerLevel;
  const angle = settings.angle * Math.PI / 180;
  const bars: Array<{
    xBottom: number;
    xTop: number;
    yBottom: number;
    yTop: number;
    stroke: number;
    empty: boolean;
  }> = [];
  let previousRightEdge: number | null = null;

  // Une barre courte, moyenne ou longue occupe respectivement un, deux ou trois niveaux.
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
    // Les extrémités contiennent une demi-épaisseur de lien au-delà de leur niveau.
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
    const barStroke = stroke * bar.widthMultiplier;
    const horizontalHalfStroke = Math.abs(rawBar.yTop - rawBar.yBottom) / axisLength * barStroke / 2;
    const rawLeftEdge = Math.min(rawBar.xBottom, rawBar.xTop) - horizontalHalfStroke;
    const rawRightEdge = Math.max(rawBar.xBottom, rawBar.xTop) + horizontalHalfStroke;
    // L'espace sépare les contours extérieurs, même lorsque les barres sont inclinées.
    const gap = settings.barGap * svgUnitsPerLevel * (1 + bar.extraGapBefore);
    const offsetX: number = previousRightEdge === null
      ? -rawLeftEdge
      : previousRightEdge + gap - rawLeftEdge;
    bars.push({
      xBottom: rawBar.xBottom + offsetX,
      xTop: rawBar.xTop + offsetX,
      yBottom: rawBar.yBottom,
      yTop: rawBar.yTop,
      stroke: barStroke,
      empty: bar.empty,
    });
    previousRightEdge = rawRightEdge + offsetX;
  }

  const polygons: Polygon[] = [];
  const linkPolygons: Polygon[] = [];
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

  // Les coupes haute et basse peuvent être rendues horizontales indépendamment.
  const barPolygons = bars.map((bar) => {
    const polygon = linePolygon(bar.xBottom, bar.yBottom, bar.xTop, bar.yTop, bar.stroke);
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

  // Un lien est horizontal et rejoint les contours réels des deux barres voisines.
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
      const linkPolygon = linePolygon(leftEdge, y, rightEdge, y, linkStroke);
      linkPolygons.push(linkPolygon);
      polygons.push(linkPolygon);
    });
  });
  polygons.push(...barPolygons.filter((_, index) => !bars[index].empty));

  // Les barres et les liens forment une seule géométrie SVG.
  if (!polygons.length) throw new Error('La notation ne contient aucune barre ni aucun lien visible.');
  const merged = polygonClipping.union(polygons[0], ...polygons.slice(1));
  const format = (value: number): string => Number(value.toFixed(4)).toString();
  // Le rayon d'arrondi s'applique à tous les coins de la géométrie fusionnée.
  const cornerRadius = settings.roundedCorners * svgUnitsPerLevel;
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

  // Le trapèze est circonscrit uniquement à la première et à la dernière barre.
  const outerSide = (polygon: Polygon, useLeftSide: boolean): [Point, Point] => {
    const ring = polygon[0];
    const sides: [Point, Point][] = [[ring[0], ring[1]], [ring[2], ring[3]]];
    return sides.sort((first, second) => {
      const firstX = (first[0][0] + first[1][0]) / 2;
      const secondX = (second[0][0] + second[1][0]) / 2;
      return useLeftSide ? firstX - secondX : secondX - firstX;
    })[0];
  };
  const upwardUnit = (side: [Point, Point]): Point => {
    const bottom = side[0][1] >= side[1][1] ? side[0] : side[1];
    const top = bottom === side[0] ? side[1] : side[0];
    const length = Math.hypot(top[0] - bottom[0], top[1] - bottom[1]);
    return [(top[0] - bottom[0]) / length, (top[1] - bottom[1]) / length];
  };
  const leftSide = outerSide(barPolygons[0], true);
  const rightSide = outerSide(barPolygons[barPolygons.length - 1], false);
  const leftDirection = upwardUnit(leftSide);
  const rightDirection = upwardUnit(rightSide);
  const axisLength = Math.hypot(
    leftDirection[0] + rightDirection[0],
    leftDirection[1] + rightDirection[1],
  );
  const symmetryAxis: Point = [
    (leftDirection[0] + rightDirection[0]) / axisLength,
    (leftDirection[1] + rightDirection[1]) / axisLength,
  ];
  const projection = (point: Point): number =>
    point[0] * symmetryAxis[0] + point[1] * symmetryAxis[1];
  const extremeBarPoints = [barPolygons[0], barPolygons[barPolygons.length - 1]]
    .flatMap((polygon) => polygon.flat()) as Point[];
  const projections = extremeBarPoints.map(projection);
  const bottomProjection = Math.min(...projections);
  const topProjection = Math.max(...projections);
  const intersectSide = (side: [Point, Point], support: number): Point => {
    const direction: Point = [side[1][0] - side[0][0], side[1][1] - side[0][1]];
    const denominator = direction[0] * symmetryAxis[0] + direction[1] * symmetryAxis[1];
    const distance = (support - projection(side[0])) / denominator;
    return [side[0][0] + direction[0] * distance, side[0][1] + direction[1] * distance];
  };
  const trapezoidPoints: Point[] = [
    intersectSide(leftSide, bottomProjection),
    intersectSide(rightSide, bottomProjection),
    intersectSide(rightSide, topProjection),
    intersectSide(leftSide, topProjection),
  ];
  const trapezoidPath = `${trapezoidPoints.map((point, index) =>
    `${index ? 'L' : 'M'}${format(point[0])} ${format(point[1])}`,
  ).join('')}Z`;
  // Sans arrondi, le mode trapèze transparent utilise une soustraction géométrique exacte.
  const usesBooleanCutout = settings.inscribedTrapezoid
    && settings.transparentShapes
    && !settings.transparentBackground
    && settings.roundedCorners === 0;
  const trapezoidPolygon: Polygon = [[...trapezoidPoints, trapezoidPoints[0]]];
  const cornerFillers: Polygon[] = [];
  // Un triangle résiduel est effacé, sauf lorsqu'il touche un lien horizontal.
  if (usesBooleanCutout) {
    const tolerance = 1e-5;
    const addCornerFillers = (polygon: Polygon): void => {
      const ring = polygon[0];
      const caps: Array<{ corners: [Point, Point]; sides: [[Point, Point], [Point, Point]] }> = [
        { corners: [ring[1], ring[2]], sides: [[ring[1], ring[0]], [ring[2], ring[3]]] },
        { corners: [ring[0], ring[3]], sides: [[ring[0], ring[1]], [ring[3], ring[2]]] },
      ];
      caps.forEach(({ corners, sides }) => {
        [bottomProjection, topProjection].forEach((support) => {
          const touches = corners.map((corner) => Math.abs(projection(corner) - support) < tolerance);
          if (touches[0] === touches[1]) return;
          const touchingIndex = touches[0] ? 0 : 1;
          const otherIndex = 1 - touchingIndex;
          const intersection = intersectSide(sides[otherIndex], support);
          const touchingCorner = corners[touchingIndex];
          const otherCorner = corners[otherIndex];
          const filler: Polygon = [[
            touchingCorner,
            otherCorner,
            intersection,
            touchingCorner,
          ]];
          const touchesHorizontalLink = linkPolygons.some((linkPolygon) => {
            const points = linkPolygon[0].slice(0, -1);
            const epsilon = 1e-5;
            const left = Math.min(...points.map((point) => point[0])) - epsilon;
            const right = Math.max(...points.map((point) => point[0])) + epsilon;
            const top = Math.min(...points.map((point) => point[1])) - epsilon;
            const bottom = Math.max(...points.map((point) => point[1])) + epsilon;
            const expandedLink: Polygon = [[
              [left, top], [right, top], [right, bottom], [left, bottom], [left, top],
            ]];
            return polygonClipping.intersection(filler, expandedLink).length > 0;
          });
          if (!touchesHorizontalLink) cornerFillers.push(filler);
        });
      });
    };
    if (!bars[0].empty) addCornerFillers(barPolygons[0]);
    if (!bars[bars.length - 1].empty) addCornerFillers(barPolygons[barPolygons.length - 1]);
  }
  const expandedCutout = cornerFillers.length
    ? polygonClipping.union(merged, ...cornerFillers)
    : merged;
  const booleanCutout = usesBooleanCutout
    ? polygonClipping.difference(trapezoidPolygon, expandedCutout)
    : [];
  const booleanCutoutPath = booleanCutout.flatMap((polygon) => polygon.map((ring) => {
    const [first, ...rest] = ring;
    return `M${format(first[0])} ${format(first[1])}${rest.map((point) =>
      `L${format(point[0])} ${format(point[1])}`,
    ).join('')}Z`;
  })).join('');

  const allX = [...bars.flatMap((bar) => [bar.xBottom, bar.xTop]), ...trapezoidPoints.map((point) => point[0])];
  const allY = [...bars.flatMap((bar) => [bar.yBottom, bar.yTop]), ...trapezoidPoints.map((point) => point[1])];
  const pad = Math.max(stroke, 10);
  const minX = Math.min(...allX) - pad;
  const maxX = Math.max(...allX) + pad;
  const minY = Math.min(...allY) - pad;
  const maxY = Math.max(...allY) + pad;
  // Le fond transparent est prévisualisé en crème et exporté en gris foncé.
  const backgroundShape = (color: string): string => settings.inscribedTrapezoid
    ? `<path d="${trapezoidPath}" fill="${color}" />`
    : `<rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="${color}" />`;
  const usesCutoutMask = settings.transparentShapes
    && !settings.transparentBackground
    && !usesBooleanCutout;
  const cutoutMask = usesCutoutMask
    ? `<defs><mask id="shape-cutout" maskUnits="userSpaceOnUse" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" style="mask-type:luminance"><rect x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" fill="white" /><path d="${pathData}" fill="black" fill-rule="evenodd" /></mask></defs>`
    : '';
  const background = settings.transparentBackground
    ? ''
    : settings.transparentShapes
      ? usesBooleanCutout
        ? `<path d="${booleanCutoutPath}" fill="#e9e8e3" fill-rule="evenodd" />`
        : `<g mask="url(#shape-cutout)">${backgroundShape('#e9e8e3')}</g>`
      : backgroundShape('#6b1426');
  const foreground = settings.transparentShapes
    ? ''
    : `<path d="${pathData}" fill="#e9e8e3" fill-rule="evenodd" />`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX - minX} ${maxY - minY}" width="200" height="200" role="img" aria-label="Logo généré">
  ${cutoutMask}
  ${background}
  ${foreground}
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
  const settings = getSettings();
  const downloadSvg = renderSvg(
    parseNotation($<HTMLInputElement>('#notation').value),
    settings,
  );
  const blob = new Blob([downloadSvg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  const encodedConfiguration = encodeConfiguration(createSavedConfiguration());
  anchor.download = `ut7-${encodedConfiguration}.svg`;
  anchor.click();
  URL.revokeObjectURL(url);
});

$('#download-png').addEventListener('click', async () => {
  if (!currentSvg) return;
  try {
    const settings = getSettings();
    const downloadSvg = renderSvg(
      parseNotation($<HTMLInputElement>('#notation').value),
      settings,
    );
    const svgDocument = new DOMParser().parseFromString(downloadSvg, 'image/svg+xml');
    const svgElement = svgDocument.documentElement;
    const viewBox = svgElement.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
    if (!viewBox || viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
      throw new Error('Les dimensions du SVG sont invalides.');
    }
    const [, , viewBoxWidth, viewBoxHeight] = viewBox;
    const maxPngSize = Math.round(200 * settings.scale);
    const ratio = viewBoxWidth / viewBoxHeight;
    const pngWidth = ratio >= 1 ? maxPngSize : Math.max(1, Math.round(maxPngSize * ratio));
    const pngHeight = ratio >= 1 ? Math.max(1, Math.round(maxPngSize / ratio)) : maxPngSize;
    svgElement.setAttribute('width', pngWidth.toString());
    svgElement.setAttribute('height', pngHeight.toString());
    const sizedSvg = new XMLSerializer().serializeToString(svgDocument);
    const svgBlob = new Blob([sizedSvg], { type: 'image/svg+xml' });
    const svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();

    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('Impossible de convertir le SVG en PNG.'));
      image.src = svgUrl;
    });
    URL.revokeObjectURL(svgUrl);

    const canvas = document.createElement('canvas');
    canvas.width = pngWidth;
    canvas.height = pngHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Le rendu PNG n’est pas disponible.');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Impossible de créer le fichier PNG.'));
      }, 'image/png');
    });
    const pngUrl = URL.createObjectURL(pngBlob);
    const anchor = document.createElement('a');
    anchor.href = pngUrl;
    const encodedConfiguration = encodeConfiguration(createSavedConfiguration());
    anchor.download = `ut7-${encodedConfiguration}.png`;
    anchor.click();
    URL.revokeObjectURL(pngUrl);
  } catch (reason) {
    error.textContent = reason instanceof Error ? reason.message : 'Impossible de télécharger le PNG.';
  }
});

$('#save-config').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('#save-config');
  try {
    const configuration = createSavedConfiguration();
    const url = new URL(window.location.href);
    url.searchParams.set('config', encodeConfiguration(configuration));
    url.hash = '';
    window.history.replaceState(null, '', url);
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url.toString());
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = url.toString();
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    button.textContent = 'URL copiée';
    window.setTimeout(() => { button.textContent = 'Sauver la configuration'; }, 1800);
  } catch {
    error.textContent = 'Impossible de copier l’URL de configuration.';
  }
});

const configurationError = restoreConfigurationFromUrl();
update();
if (configurationError) error.textContent = configurationError;
