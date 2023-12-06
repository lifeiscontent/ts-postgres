/* eslint-disable @typescript-eslint/no-non-null-assertion */

import { DatabaseError } from './protocol';

type Resolution = null | string | Error | DatabaseError;
type Resolver = (resolution: Resolution) => void;
type ResultHandler = (resolve: Resolver) => void;
type Callback<T> = (item: T) => void;

export class ResultRowImpl<T> {
    private readonly lookup: {[name: string]: number};

    constructor(public readonly names: string[], public readonly data: any[]) {
        const lookup: {[name: string]: number} = {};
        let i = 0;
        for (const name of names) {
            lookup[name] = i;
            i++;
        }
        this.lookup = lookup;
    }

    [Symbol.iterator](): Iterator<any> {
        return this.data[Symbol.iterator]();
    }

    get(name: string): any {
        const i = this.lookup[name];
        return this.data[i];
    }

    reify(): T {
        const data = this.data;
        const result: Record<string, any> = {};
        this.names.forEach((key, i) => result[key] = data[i]);
        return result as T;
    }
}

/** The default result type, used if no generic type parameter is specified. */
export type ResultRecord = Record<string, any>

/**
 * A result row provides access to data for a single row.
 *
 * The generic type parameter is carried over from the query method.
 * @interface
 *
 * To retrieve a column value by name use the {@link get} method; or use {@link reify} to convert
 * the row into an object.
 *
 * The {@link data} attribute provides raw access to the row data, but it's also possible to use the
 * spread operator to destructure into a tuple.
 */
export type ResultRow<T = ResultRecord> = Omit<ResultRowImpl<T>, 'get'> & {
    get<K extends keyof T>(name: K): T[K];
}

export class Result<T = ResultRecord> {
    constructor(
        public names: string[],
        public rows: any[][],
        public status: null | string
    ) { }

    [Symbol.iterator](): Iterator<ResultRow<T>> {
        let i = 0;

        const rows = this.rows;
        const length = rows.length;

        const shift = () => {
            const names = this.names;
            const values = rows[i];
            i++;
            return new ResultRowImpl<T>(names, values) as unknown as ResultRow<T>;
        };

        return {
            next: () => {
                if (i === length) return { done: true, value: undefined! };
                return { done: false, value: shift() };
            }
        }
    }

    reify(): T[] {
        return this.rows.map(data => {
            const result: Record<string, any> = {};
            this.names.forEach((key, i) => result[key] = data[i]);
            return result;
        }) as T[];
    }
}

export class ResultIterator<T = ResultRecord> extends Promise<Result<T>> {
    private subscribers: (
        (done: boolean, error?: (string | DatabaseError | Error)
        ) => void)[] = [];
    private done = false;

    public rows: any[][] | null = null;
    public names: string[] | null = null;

    constructor(private container: any[][], executor: ResultHandler) {
        super((resolve, reject) => {
            executor((resolution) => {
                if (resolution instanceof Error) {
                    reject(resolution);
                } else {
                    const names = this.names || [];
                    const rows = this.rows || [];
                    resolve(new Result(names, rows, resolution));
                }
            });
        });
    }

    async first() {
        for await (const row of this) {
            return row;
        }
    }

    async one() {
        for await (const row of this) {
            return row;
        }
        throw new Error('Query returned an empty result');
    }

    reify(): AsyncIterable<T> {
        const iterator: AsyncIterator<ResultRow<T>> = this[Symbol.asyncIterator]();
        return {
            [Symbol.asyncIterator]() {
                return {
                    async next() {
                        const { done, value } = await iterator.next();
                        if (done) return { done, value: null };
                        return { done, value: value.reify() };
                    },
                    async return() {
                        if (iterator?.return) await iterator?.return();
                        return { done: true, value: null };
                    }
                };
            }
        }
    }

    notify(done: boolean, status?: (string | DatabaseError | Error)) {
        if (done) this.done = true;
        for (const subscriber of this.subscribers) subscriber(done, status);
        this.subscribers.length = 0;
    }

    [Symbol.asyncIterator](): AsyncIterator<ResultRow<T>> {
        let i = 0;

        const container = this.container;

        const shift = () => {
            const names = this.names;
            const values = container[i];
            i++;

            if (names === null) {
                throw new Error("Column name mapping missing.");
            }

            return new ResultRowImpl<T>(names, values) as unknown as ResultRow<T>;
        };

        /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
        let error: any = null;

        this.catch((reason) => {
            error = new Error(reason);
        });

        return {
            next: async () => {
                if (error) {
                    throw error;
                }

                if (container.length <= i) {
                    if (this.done) {
                        return { done: true, value: undefined! };
                    }

                    if (await new Promise<boolean>(
                        (resolve, reject) => {
                            this.subscribers.push(
                                (done, status) => {
                                    if (typeof status !== 'undefined') {
                                        reject(status);
                                    } else {
                                        resolve(done)
                                    }
                                });
                        })) {
                        return { done: true, value: undefined! };
                    }
                }

                return { value: shift(), done: false };
            }
        };
    }
}

export type DataHandler<T> = Callback<T | Resolution>;

export type NameHandler = Callback<string[]>;

ResultIterator.prototype.constructor = Promise

export function makeResult<T>() {
    let dataHandler: DataHandler<any[] | null> | null = null;
    const nameHandler = (names: string[]) => {
        p.names = names;
    }
    const rows: any[][] = [];
    const p = new ResultIterator<T>(rows, (resolve) => {
        dataHandler = ((row: any[] | Resolution) => {
            if (row === null || typeof row === 'string') {
                p.rows = rows;
                resolve(row);
                p.notify(true);
            } else if (Array.isArray(row)) {
                rows.push(row);
                p.notify(false);
            } else {
                resolve(row);
                p.notify(true, row);
            }
        });
    });

    return {
        iterator: p,
        dataHandler: dataHandler!,
        nameHandler: nameHandler
    };
}
