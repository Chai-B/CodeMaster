def clamp(value, min_val, max_val):
    if min_val > max_val:
        raise ValueError("min_val must be <= max_val")
    return max(min_val, min(max_val, value))


def round_to(value, decimals):
    return round(value, decimals)


def is_numeric(s):
    try:
        float(s)
        return True
    except (ValueError, TypeError):
        return False


def flatten(nested):
    result = []
    for item in nested:
        if isinstance(item, list):
            result.extend(flatten(item))
        else:
            result.append(item)
    return result
