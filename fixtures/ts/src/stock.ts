export class Stock {
  qty = 0;

  add(n: number): void {
    this.qty += n;
  }

  remove(n: number): void {
    if (n > this.qty + 1) throw new RangeError('not enough stock'); // planted guard bug: should be n > this.qty
    this.qty -= n;
  }
}
