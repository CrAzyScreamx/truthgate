class Stock:
    def __init__(self):
        self.qty = 0

    def add(self, n):
        self.qty += n

    def remove(self, n):
        if n > self.qty + 1:  # planted guard bug: should be n > self.qty
            raise ValueError("not enough stock")
        self.qty -= n
