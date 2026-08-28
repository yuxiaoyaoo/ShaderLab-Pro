float hash21(vec2 p)
{
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

void mainImage(out vec4 fragColor, in vec2 fragCoord)
{
    vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;

    vec3 col = mix(vec3(0.015, 0.025, 0.06), vec3(0.045, 0.06, 0.13), uv.y * 0.5 + 0.5);
    col += vec3(0.05, 0.04, 0.09) * exp(-pow(length(uv - vec2(0.0, -0.55)), 2.0) * 3.0);

    vec2 sq = uv * 34.0;
    vec2 sid = floor(sq);
    vec2 sf = fract(sq) - 0.5;
    float sh = hash21(sid);
    if (sh > 0.978)
    {
        vec2 soff = vec2(hash21(sid + 1.7), hash21(sid + 3.1)) - 0.5;
        float sd2 = length(sf - soff * 0.6);
        float tw = 0.55 + 0.45 * sin(iTime * (1.2 + 3.0 * fract(sh * 53.0)) + sh * 71.0);
        col += vec3(0.85, 0.9, 1.0) * (1.0 - smoothstep(0.02, 0.10, sd2)) * tw * 0.7;
    }

    for (int j = 0; j < 5; j++)
    {
        float fj = float(j);
        float hA = hash21(vec2(fj * 1.31, 3.17));
        float hB = hash21(vec2(fj * 2.57, 7.71));
        float hC = hash21(vec2(fj * 0.73, 9.43));
        float hD = hash21(vec2(fj * 1.97, 5.11));
        float hE = hash21(vec2(fj * 3.29, 1.89));

        float cycle = 2.4 + 2.8 * hB;
        float flight = 0.82 * cycle;
        float tt = fract((iTime + hC * cycle) / cycle);
        float dur = flight / cycle;

        if (tt < dur)
        {
            float q = tt / dur;
            float qe = pow(q, 1.35);

            float ang = 3.72 + 0.62 * hA;
            vec2 dir = vec2(cos(ang), sin(ang));
            vec2 p0 = vec2(-1.05 + 2.2 * hD, 0.72 + 0.22 * hE);
            float travel = 1.55 + 1.25 * hB;

            vec2 head = p0 + dir * travel * qe;
            float tl = 0.17 + 0.15 * hD;
            vec2 s0 = head - dir * tl;
            vec2 e = head - s0;

            vec2 pa = uv - s0;
            float h2 = dot(e, e);
            float tj = clamp(dot(pa, e) / max(h2, 1e-5), 0.0, 1.0);
            float dj = length(pa - e * tj);

            float lifeEnv = smoothstep(0.0, 0.12, q) * smoothstep(1.0, 0.72, q);
            float core = exp(-dj * dj * 1100.0);
            float halo = exp(-dj * dj * 240.0) * 0.28;
            float along = pow(1.0 - tj, 1.7);

            vec3 trailCol = mix(vec3(0.5, 0.72, 1.0), vec3(1.0, 0.96, 0.88), tj * tj);
            col += trailCol * (core + halo) * along * lifeEnv * 1.7;
            col += vec3(1.0) * exp(-pow(length(uv - head), 2.0) * 5200.0) * lifeEnv * 0.9;
        }
    }

    col = 1.0 - exp(-col * 1.35);
    fragColor = vec4(col, 1.0);
}
