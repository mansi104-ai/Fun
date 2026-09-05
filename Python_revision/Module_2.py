#Control flow basics : if,else, elif, while, break, continue, pass, range()
score = 82
if score >= 90:
  grade = "A"
elif score >= 75:
  grade = "B"
else:
  grade = "C"
print(grade)

#for loop with range
for i in range(5):
  # print(i)
  if i == 3:
    break
  print(i)

#while loop
count = 0
while count<3:
  print("Counting",count)
  count+= 1

##Hands-on 1
count= 1
while count < 21:
  if count % 3 == 0 and count % 5 == 0:
      print("Fizzbuzz")
  elif count % 3 == 0:
    print("Fizz")
  elif count % 5 == 0:
    print("Buzz")
  else:
    print(count)
  count+=1 

##Hands-on 2
sum_of_100 = sum(range(1,100))
sum_2 = 0
for i in range(101):
  sum_2+= i
print(sum_of_100)
print(sum_2)
print(sum_2 == sum_of_100)

##Hands-on 3
num = 100
while num >= 1:
  print(num)
  num /= 2

##Hands-on 4
for i in range(1, 11):
    if i % 2 == 0:
        continue
    print(i)

## Break : exit the loop entirely, Continue : skip the rest of the current iteration and move to the next one 
##Pass : does nothing, placeholder for a syntax requiring a statement or an empty function body



  