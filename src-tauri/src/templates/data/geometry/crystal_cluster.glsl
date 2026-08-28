float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float smin(float a, float b, float k)
{
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

float sdOcta(vec3 p, float s)
{
    p.y *= 0.82;
    p.xz *= 1.12;
    vec3 o = abs(p);
    return (o.x + o.y + o.z - s) * 0.57735027;
}

float map(vec3 p)
{
    float d = p.y + 0.9;
    for (int i = 0; i < 5; i++)
    {
        float fi = float(i);
        float ha = hash21(vec2(fi, 17.0));
        float hb = hash21(vec2(fi, 29.0));
        float hc = hash21(vec2(fi, 43.0));

        float ang = 6.2831853 * fi / 5.0 + ha * 0.8;
        float rad = 0.16 + 0.26 * hb;
        vec3 c = vec3(cos(ang) * rad, -0.92, sin(ang) * rad);

        vec3 q = p - c;
        float yaw = ang + 0.6;
        float cy = cos(yaw), sy = sin(yaw);
        q.xz = mat2(cy, sy, -sy, cy) * q.xz;
        float tilt = (hc - 0.5) * 0.85;
        float ct = cos(tilt), st = sin(tilt);
        q.yz = mat2(ct, st, -st, ct) * q.yz;

        d = smin(d, sdOcta(q, 0.20 + 0.16 * fract(ha * 11.0)), 0.09);
    }
    return d;
}

vec3 calcNormal(vec3 p)
{
    vec2 e = vec2(0.002, 0.0);
    return normalize(vec3(
        map(p + e.xyy) - map(p - e.xyy),
        map(p + e.yxy) - map(p - e.yxy),
        map(p + e.yyx) - map(p - e.yyx)));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 ro = vec3(sin(iTime * 0.12) * 0.85, 0.32, -2.3 + cos(iTime * 0.12) * 0.35);
    vec3 ta = vec3(0.0, -0.05, 0.0);
    vec3 fwd = normalize(ta - ro);
    vec3 rgt = normalize(cross(fwd, vec3(0.0, 1.0, 0.0)));
    vec3 upv = cross(rgt, fwd);
    vec3 rd = normalize(uv.x * rgt + uv.y * upv + fwd * 1.55);

    vec3 ldir = normalize(vec3(0.5, 0.75, -0.42));

    float t = 0.0;
    bool hit = false;
    vec3 p = ro;
    int steps = 0;
    for (int i = 0; i < 90; i++)
    {
        p = ro + rd * t;
        float h = map(p);
        if (h < 0.0013)
        {
            hit = true;
            break;
        }
        t += min(h * 0.62, 0.28);
        steps = i;
        if (t > 9.0)
        {
            break;
        }
    }

    vec3 col;
    if (hit)
    {
        vec3 n = calcNormal(p);
        float ao = clamp(1.0 - float(steps) / 68.0, 0.3, 1.0);

        float dif = max(dot(n, ldir), 0.0);
        float spe = pow(max(dot(reflect(rd, n), ldir), 0.0), 44.0);
        float fre = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);

        float snowM = smoothstep(0.74, 0.9, n.y) * smoothstep(-0.80, -0.86, p.y);
        vec3 alb = mix(vec3(0.58, 0.80, 0.92), vec3(0.74, 0.79, 0.86), snowM);

        float axisGlow = exp(-dot(p.xz, p.xz) * 3.0) * exp(-(p.y + 0.5) * 1.5);
        vec3 emis = vec3(0.25, 0.65, 0.95) * (0.15 + 0.1 * sin(iTime * 1.4 + p.y * 5.0)) * axisGlow * (1.0 - snowM);

        col = alb * (0.14 + 0.62 * dif) * (0.55 + 0.45 * ao)
            + vec3(0.28, 0.36, 0.5) * 0.28 * ao
            + vec3(1.0) * spe * (0.5 + 1.2 * (1.0 - snowM))
            + vec3(0.7, 0.85, 1.0) * fre * 0.55
            + emis;
        col = mix(col, vec3(0.5, 0.58, 0.68), 1.0 - exp(-t * 0.16));
    }
    else
    {
        col = mix(vec3(0.38, 0.47, 0.6), vec3(0.1, 0.16, 0.3), smoothstep(-0.05, 0.65, rd.y));
        col += vec3(1.0, 0.9, 0.75) * pow(max(dot(rd, ldir), 0.0), 90.0) * 0.9;
    }

    col *= 1.0 - 0.32 * dot(uv, uv);
    col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
    fragColor = vec4(col, 1.0);
}
