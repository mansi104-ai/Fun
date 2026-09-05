# sentences = "the quick brown fox jumps"
# lengths = {word: len(word) for word in sentences.split()}
# print(lengths)

# names = ["heena","meena","seena","reena"]
# scores = [20,21,33,34]
# classes = [2,3,4]
# zip_comprehension = {n:(s,c) for n,s,c in zip(names, scores,classes)}
# print(zip_comprehension)

# animals = ["cow","peacock","bull"]
# final_list = list(filter(lambda animals: len(animals) >3,animals))
# final_list_comprehension = [w for w in animals if len(w) > 3]
# # final_list_sorted = list(sorted(final_list_comprehension, key= lambda a:a[0]))
# final_list_sorted = sorted(animals,key = lambda x:x[0])
# print(final_list)
# print(final_list_comprehension)
# print(final_list_sorted)

# text = "the cat sat on the mat the cat ran"
# from collections import Counter
# most_common = Counter(text.split()).most_common(2)
# words = [len(x[0]) for x in most_common]
# print(words)