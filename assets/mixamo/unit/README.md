# Mixamo → unit-kit

Сюда кладутся FBX из [mixamo.com](https://www.mixamo.com) для одного персонажа.
Скрипт `assets/build-unit-kit.py` подбирает файлы по маскам имён:

| Клип | Маска | Что качать в Mixamo | Настройки |
| --- | --- | --- | --- |
| персонаж | не подходит ни под одну маску, или `character*.fbx` | персонаж, T-Pose | FBX Binary, With Skin, без клипа |
| `idle` | `*idle*` | Rifle Idle | Without Skin |
| `run` | `*run*` | Rifle Run | Without Skin, **In Place** |
| `aim` | `*aim*` | Rifle Aiming Idle | Without Skin |
| `fire` | `*fir*` | Firing Rifle | Without Skin |
| `die` | `*d*ing*` | Dying (или Death From Front) | Without Skin |

Клипы «Without Skin» весят копейки и импортируются с тем же скелетом; клипы
«With Skin» тоже подойдут — меш из них выбрасывается. Персонаж — любой
гуманоид Mixamo (Y Bot без текстур — самый лёгкий): текстуры всё равно
снимаются, материал один плоский, цвет стороны кладёт рендер.

Сборка:

```
npm run assets:unit
```

Пишет `assets/unit.blend` и `public/models/unit-kit.glb`, затем упаковывает
meshopt. Файлы Mixamo в репозиторий не коммитятся (лицензия Adobe) — папка
в `.gitignore`, кроме этого README.
