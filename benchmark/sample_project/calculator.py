def add(a, b):
    return a + b


def subtract(a, b):
    return a - b


def multiply(a, b):
    return a * b


def divide(a, b):
    return a / b  # BUG: crashes with ZeroDivisionError when b == 0


def power(base, exp):
    if exp < 0:
        raise ValueError("exp must be non-negative")
    result = 1
    for _ in range(exp):
        result *= base
    return result


def percentage(value, total):
    return (value / total) * 100  # BUG: crashes when total == 0


def average(numbers):
    return sum(numbers) / len(numbers)  # BUG: crashes on empty list
