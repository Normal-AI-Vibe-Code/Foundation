/** "1 person", "3 people", "1 board", "2 boards": counts read the way people say them. */
export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}
