"""Module I: Performance Analyzer — benchmark + multi-core simulation"""
import time
import multiprocessing
from typing import List
from ir_builder import IRProgram
from dependency_analyzer import DependencyReport


def estimate_performance(ir: IRProgram, reports: List[DependencyReport]) -> dict:
    parallel_count = sum(1 for r in reports if r.parallelizable)
    total_loops    = len(reports)
    cpu_cores      = multiprocessing.cpu_count()

    if total_loops == 0:
        return _empty_metrics(cpu_cores)

    workload = 400_000

    # Sequential benchmark
    t0 = time.perf_counter()
    _cpu_work(workload * max(total_loops, 1))
    seq_ms = round((time.perf_counter() - t0) * 1000, 2)

    # Parallel benchmark
    par_ms = seq_ms  # default if nothing to parallelize
    if parallel_count > 0:
        t0 = time.perf_counter()
        try:
            with multiprocessing.Pool(min(cpu_cores, parallel_count + 1)) as pool:
                pool.map(_cpu_work, [workload] * parallel_count)
        except Exception:
            _cpu_work(workload * parallel_count)
        par_ms = round((time.perf_counter() - t0) * 1000, 2)

    speedup    = round(seq_ms / par_ms, 2) if par_ms > 0 else 1.0
    efficiency = round((speedup / cpu_cores) * 100, 1)

    # p = fraction of parallelizable work
    p = parallel_count / total_loops if total_loops > 0 else 0

    # Core simulation with Amdahl + Gustafson
    core_sim = {}
    for cores in [2, 4, 8]:
        # Amdahl: S(n) = 1 / ((1-p) + p/n)
        amdahl = round(1.0 / ((1 - p) + p / cores), 2) if p > 0 else 1.0
        # Gustafson: S(n) = n - (1-p) * (n-1)
        gustafson = round(cores - (1 - p) * (cores - 1), 2)
        est_par = round(seq_ms / amdahl, 2)
        core_sim[f"{cores}_cores"] = {
            "estimated_speedup": amdahl,
            "estimated_parallel_ms": est_par,
            "sequential_ms": seq_ms,
            "gustafson_speedup": gustafson
        }

    # Performance law data for plotting
    cores_list = [1, 2, 4, 8, 16, 32]

    def amdahl(n):
        if n == 1 or p == 0:
            return 1.0
        return round(1.0 / ((1 - p) + p / n), 4)

    def gustafson(n):
        return round(n - (1 - p) * (n - 1), 4)

    # Crossover point: where parallel becomes faster than sequential
    # Based on actual measured per-iteration time from the benchmark
    t_iter_ms = seq_ms / (workload * max(total_loops, 1)) if seq_ms > 0 else 0.001
    overhead_ms = par_ms - (seq_ms / speedup) if speedup > 1 and par_ms > 0 else 2.0
    overhead_ms = max(overhead_ms, 0.1)  # floor at 0.1ms
    best_cores  = min(cpu_cores, 8)
    if best_cores > 1 and p > 0 and t_iter_ms > 0:
        crossover_n = round(overhead_ms / (t_iter_ms * (1 - 1.0 / best_cores)))
        crossover_n = max(crossover_n, 1)
    else:
        crossover_n = None

    performance_law_data = {
        "cores": cores_list,
        "amdahl": [amdahl(c) for c in cores_list],
        "gustafson": [gustafson(c) for c in cores_list],
        "crossover_n": crossover_n
    }

    return {
        "sequential_time_ms": seq_ms,
        "parallel_time_ms":   par_ms,
        "speedup":            speedup,
        "cpu_cores":          cpu_cores,
        "parallel_loops":     parallel_count,
        "total_loops":        total_loops,
        "efficiency":         efficiency,
        "parallelizable_fraction": round(p * 100, 1),
        "core_simulation":    core_sim,
        "performance_law_data": performance_law_data
    }


def _empty_metrics(cpu_cores):
    return {
        "sequential_time_ms": 0, "parallel_time_ms": 0,
        "speedup": 1.0, "cpu_cores": cpu_cores,
        "parallel_loops": 0, "total_loops": 0,
        "efficiency": 0, "parallelizable_fraction": 0,
        "core_simulation": {
            "2_cores": {"estimated_speedup": 1.0, "estimated_parallel_ms": 0,
                        "sequential_ms": 0, "gustafson_speedup": 1.0},
            "4_cores": {"estimated_speedup": 1.0, "estimated_parallel_ms": 0,
                        "sequential_ms": 0, "gustafson_speedup": 1.0},
            "8_cores": {"estimated_speedup": 1.0, "estimated_parallel_ms": 0,
                        "sequential_ms": 0, "gustafson_speedup": 1.0},
        },
        "performance_law_data": {
            "cores": [1, 2, 4, 8, 16, 32],
            "amdahl": [1.0] * 6,
            "gustafson": [1.0] * 6,
            "crossover_n": None
        }
    }


def _cpu_work(n):
    total = 0
    for i in range(n):
        total += i * i
    return total
