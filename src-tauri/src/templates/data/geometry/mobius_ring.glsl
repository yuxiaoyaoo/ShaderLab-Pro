float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

float segDist(vec2 p, vec2 a, vec2 b)
{
    vec2 e = b - a;
    float h = max(dot(e, e), 1e-6);
    float t = clamp(dot(p - a, e) / h, 0.0, 1.0);
    return length(p - a - e * t);
}

vec3 rotYX(vec3 p, float ay, float ax)
{
    float cy = cos(ay), sy = sin(ay);
    p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
    float cx = cos(ax), sx = sin(ax);
    p = vec3(p.x, cx * p.y - sx * p.z, sx * p.y + cx * p.z);
    return p;
}

vec3 mobiusPoint(float u, float v)
{
    float cu = cos(u * 0.5) * v;
    return vec3((1.0 + cu) * cos(u), (1.0 + cu) * sin(u), sin(u * 0.5) * v);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 col = vec3(0.012, 0.016, 0.03);

    vec2 sq = uv * 44.0;
    vec2 sid = floor(sq);
    vec2 sf = fract(sq) - 0.5;
    float sh = hash21(sid);
    if (sh > 0.984)
    {
        vec2 soff = vec2(hash21(sid + 2.3), hash21(sid + 4.7)) - 0.5;
        float sd2 = length(sf - soff * 0.6);
        float tw = 0.5 + 0.5 * sin(iTime * (1.0 + 2.5 * fract(sh * 37.0)) + sh * 61.0);
        col += vec3(0.8, 0.86, 1.0) * (1.0 - smoothstep(0.015, 0.08, sd2)) * tw * 0.5;
    }

    float ry = iTime * 0.42;
    float rx = -0.52;
    float acc = 0.0;
    vec3 cAcc = vec3(0.0);

    for (int b = 0; b < 5; b++)
    {
        float fv = float(b);
        float v = mix(-0.34, 0.34, fv / 4.0);

        float uP = 0.0;
        vec3 wP = rotYX(mobiusPoint(uP, v), ry, rx);
        float perspP = 0.25 / max(1.55 - wP.z * 0.42, 0.4);
        vec2 sP = wP.xy * perspP;
        float zP = wP.z;

        for (int i = 1; i <= 44; i++)
        {
            float uC = 6.2831853 * float(i) / 44.0;
            vec3 wC = rotYX(mobiusPoint(uC, v), ry, rx);
            float perspC = 0.25 / max(1.55 - wC.z * 0.42, 0.4);
            vec2 sC = wC.xy * perspC;
            float zC = wC.z;

            float zm = 0.5 * (zP + zC);
            float wgt = 0.20 + 1.05 * smoothstep(-0.7, 0.75, zm);
            float um = 0.5 * (uP + uC);
            float hue = 0.5 + 0.5 * sin(3.0 * um + v * 2.4 + iTime * 0.22);
            vec3 bc = mix(vec3(0.22, 0.78, 0.96), vec3(0.95, 0.32, 0.68), hue);

            float dj = segDist(uv, sP, sC);
            float g = wgt * (exp(-dj * dj * 5400.0) * 1.1 + exp(-dj * dj * 620.0) * 0.3);
            acc += g;
            cAcc += bc * g;

            uP = uC;
            sP = sC;
            zP = zC;
        }
    }

    col += cAcc;
    col *= 1.0 + 0.06 * acc;
    col = 1.0 - exp(-col * 1.25);
    fragColor = vec4(col, 1.0);
}
