"""Share the operator's linked course folders with another account (LOCAL_MODE).

    uv run --env-file .env --env-file .env.docker python scripts/share_folders.py friend@example.com

For every course folder the operator has linked to a folder on this Mac
(Files → Link folder), the friend's account gets the same link — so both see
the same files live — plus a copy of the course itself (name, colour, …) so
it shows up in their Courses. Their tasks, topics, progress and settings stay
their own. Safe to re-run: existing courses/links are left alone.

Note: edits are shared too — a file deleted or renamed by either of you is
gone for both, since it's the same folder on disk.
"""
from __future__ import annotations

import asyncio
import os
import sys
from uuid import UUID


async def main(email: str) -> int:
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    from app import db
    from app.config import get_settings
    from app.schemas import CourseCreate
    from app.services import courses as courses_svc
    from app.services import storage

    operator = UUID(get_settings().operator_user_id)
    await db.init_pool()
    try:
        row = await db.fetchrow("SELECT id FROM users WHERE lower(email) = lower(%s)", email)
        if row is None:
            print(f"no account for {email} — they need to sign up first")
            return 1
        friend = UUID(str(row["id"]))
        if friend == operator:
            print("that's the operator's own account")
            return 1

        op_root = storage._user_root(operator)
        links = sorted(p for p in op_root.iterdir() if p.is_symlink()) if op_root.exists() else []
        if not links:
            print("you haven't linked any course folders yet (Files → Link folder)")
            return 1

        op_courses = {c.folder_name or c.code: c for c in await courses_svc.list_courses(operator)}
        for link in links:
            target = link.resolve()
            if storage.linked_folder(friend, link.name):
                print(f"= {link.name}: already shared")
            else:
                try:
                    storage._link_folder_sync(friend, link.name, target)
                    print(f"+ {link.name} → {target}")
                except (FileExistsError, ValueError) as exc:
                    print(f"! {link.name}: {exc}")
                    continue
            course = op_courses.get(link.name)
            if course and not await courses_svc.get_course(friend, course.code):
                fields = CourseCreate.model_fields.keys()
                await courses_svc.create_course(friend, CourseCreate(**course.model_dump(include=set(fields))))
                print(f"  + course {course.code} ({course.full_name})")
        return 0
    finally:
        await db.close_pool()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(asyncio.run(main(sys.argv[1])))
