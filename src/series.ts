// Reads the rows of one coin and one `src` from the daily files (ADR 0004 D1, D7).
import { dailyPath, readDailyPoints } from './csv.ts';
import { isoSeconds, parseIso } from './time.ts';
import type { PricePoint, SeriesReader, SrcCode } from './types.ts';

const DAY_MS = 86_400_000;

/**
 * `onMalformed` is called once per file that has lines the reader had to skip. The default writes a
 * warning to stderr. The text of the lines is never reported.
 */
export function createSeriesReader(
	dataRoot: string,
	onMalformed: (file: string, count: number) => void = (file, count) => {
		console.warn(`Skipped ${count} malformed line(s) in ${file}`);
	}
): SeriesReader {
	return {
		async readSeries(
			coin: string,
			fromIso: string,
			toIso: string,
			src: SrcCode
		): Promise<PricePoint[]> {
			const from = parseIso(fromIso);
			const to = parseIso(toIso);
			const result: PricePoint[] = [];
			const firstDay = Math.floor(from / DAY_MS) * DAY_MS;
			for (let day = firstDay; day <= to; day += DAY_MS) {
				const file = dailyPath(
					dataRoot,
					coin,
					isoSeconds(new Date(day))
				);
				const { points, malformed } = await readDailyPoints(file);
				if (malformed > 0) {
					onMalformed(file, malformed);
				}
				for (const point of points) {
					const time = parseIso(point.ts);
					if (point.src === src && time >= from && time < to) {
						result.push(point);
					}
				}
			}
			// Array.prototype.sort is stable, so equal times keep the file order.
			return result.sort((a, b) => parseIso(a.ts) - parseIso(b.ts));
		},
	};
}
