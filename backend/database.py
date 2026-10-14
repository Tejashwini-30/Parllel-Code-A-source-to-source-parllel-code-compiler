"""Database layer using SQLite"""
import sqlite3
import json
import os
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "autoparallel.db")


def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_conn()
    c = conn.cursor()
    c.executescript("""
        CREATE TABLE IF NOT EXISTS programs (
            program_id   INTEGER PRIMARY KEY AUTOINCREMENT,
            language     TEXT NOT NULL,
            source_code  TEXT NOT NULL,
            created_at   TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dependencies (
            dependency_id INTEGER PRIMARY KEY AUTOINCREMENT,
            program_id    INTEGER,
            variable      TEXT,
            type          TEXT,
            source_line   INTEGER,
            target_line   INTEGER,
            FOREIGN KEY(program_id) REFERENCES programs(program_id)
        );

        CREATE TABLE IF NOT EXISTS parallel_segments (
            segment_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            program_id      INTEGER,
            loop_line       INTEGER,
            parallelizable  INTEGER,
            transformation  TEXT,
            FOREIGN KEY(program_id) REFERENCES programs(program_id)
        );

        CREATE TABLE IF NOT EXISTS execution_metrics (
            metric_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            program_id       INTEGER,
            sequential_time  REAL,
            parallel_time    REAL,
            speedup          REAL,
            FOREIGN KEY(program_id) REFERENCES programs(program_id)
        );
    """)
    conn.commit()
    conn.close()


def save_analysis(language, source_code, dep_reports, par_reports, metrics) -> int:
    conn = get_conn()
    c = conn.cursor()

    c.execute("INSERT INTO programs (language, source_code, created_at) VALUES (?,?,?)",
              (language, source_code, datetime.utcnow().isoformat()))
    program_id = c.lastrowid

    for report in dep_reports:
        for dep in report.dependencies:
            c.execute("""INSERT INTO dependencies
                         (program_id, variable, type, source_line, target_line)
                         VALUES (?,?,?,?,?)""",
                      (program_id, dep.variable, dep.dep_type,
                       dep.source_line, dep.target_line))

    for report in par_reports:
        c.execute("""INSERT INTO parallel_segments
                     (program_id, loop_line, parallelizable, transformation)
                     VALUES (?,?,?,?)""",
                  (program_id, report.loop_line,
                   1 if report.parallelizable else 0, report.reason))

    if metrics:
        c.execute("""INSERT INTO execution_metrics
                     (program_id, sequential_time, parallel_time, speedup)
                     VALUES (?,?,?,?)""",
                  (program_id, metrics.get("sequential_time_ms", 0),
                   metrics.get("parallel_time_ms", 0),
                   metrics.get("speedup", 1.0)))

    conn.commit()
    conn.close()
    return program_id


def get_history(limit=20):
    conn = get_conn()
    c = conn.cursor()
    rows = c.execute("""
        SELECT p.program_id, p.language, p.created_at,
               em.speedup, em.sequential_time, em.parallel_time
        FROM programs p
        LEFT JOIN execution_metrics em ON p.program_id = em.program_id
        ORDER BY p.created_at DESC LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]
