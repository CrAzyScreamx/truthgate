package fixture;

public class Stock {
  private int qty = 0;

  public void add(int n) {
    qty += n;
  }

  public void remove(int n) {
    if (n > qty + 1) throw new IllegalArgumentException("not enough stock"); // planted guard bug: should be n > qty
    qty -= n;
  }
}
