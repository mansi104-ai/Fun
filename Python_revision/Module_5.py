# class Rectangle:
#   shape_type = "quadrilateral"

#   def __init__(self, width, height):
#     self.width = width
#     self.height = height

#   def area(self):
#     return self.width * self.height

#   def __str__(self):
#     return f"Rectangle({self.width}x{self.height})"

# class Square(Rectangle):
#   def __init__(self,side):
#     super().__init__(side,side)
# r = Rectangle(4,5)
# print(r.area(),r)
# s = Square(3)
# print(s.area(),isinstance(s,Rectangle))

# class MathHelper:
#   @staticmethod
#   def add(a,b):
#     return a+b

#   @classmethod
#   def describe(cls):
#     return f"This is {cls.__name__}"

# r = MathHelper.describe()
# print(r)

##Hands-on 1
# class BankAccount:
#     def __init__(self, balance=0):
#         self.balance = balance

#     def deposit(self, amount):
#         self.balance += amount

#     def withdraw(self, amount):
#         if amount > self.balance:
#             raise ValueError("Insufficient funds")
#         self.balance -= amount

#     def __str__(self):
#         return f"Balance: {self.balance}"

# r = BankAccount()
# r.deposit(20)
# r.withdraw(10)
# print(r.balance)

class Circle:
    pi = 0.314159
    def __init__(self,radius):
        self.radius = radius

    def area(self):
        return Circle.pi *self.radius ** 2

r = Circle(radius= 20)
# r.radius = 20
print(r.area())

